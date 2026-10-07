import { describe, expect, it, vi } from "vitest";
import { NativeMcpAuthorization } from "./mcp-authorization.js";
import { mcpConfigurationDigest, type McpOperation } from "../shared/mcp-authorization.js";
import { mcpDigest } from "../core/mcp-operation-policy.js";
import type { CertificateIdentity } from "./security/cert-manager.js";

const config = { transport: "streamable-http" as const, url: "https://mcp.example.test/api", headers: { Authorization: "Bearer PRIVATE_TEST_MCP_TOKEN" },
  env: { SICLAW_MCP_OPERATION_POLICY: JSON.stringify({ version: 1, tools: { query: { effect: "read", fixedArguments: { "/tenant": "team-a" },
    allowedArguments: { "/namespace": ["sicore-test"] } }, mutate: { effect: "write" } } }) } };
const identity = { agentId: "a", orgId: "o", boxId: "b" } as CertificateIdentity;
const operation: McpOperation = { server: "metrics", kind: "tool", name: "query", callId: "call-1",
  arguments: { tenant: "team-a", namespace: "sicore-test" }, configurationDigest: mcpConfigurationDigest(config) };
function fixture() {
  let user = "user-a";
  const request = vi.fn(async (method: string) => {
    if (method === "sandbox.resolve") return { user_id: "user-a" };
    if (method === "config.getResources") return { mcp_server_ids: ["mcp-1"] };
    if (method === "config.getMcpServers") return { mcpServers: { metrics: config } };
    throw new Error("Unknown privileged RPC");
  });
  const authorization = new NativeMcpAuthorization({ request }, () => user);
  return { authorization, request, setUser: (value: string) => { user = value; } };
}
describe("native MCP current caller + selected resource authorization", () => {
  it("returns only a read permit bound to the exact caller, operation, arguments and configuration", async () => {
    const f = fixture();
    const permit = await f.authorization.authorize(identity, "s", operation, new AbortController().signal);
    expect(permit).toMatchObject({ effect: "read", agentId: "a", sessionId: "s", userId: "user-a", argumentsDigest: mcpDigest(operation.arguments) });
    expect(JSON.stringify(permit)).not.toContain("PRIVATE_TEST_MCP_TOKEN");
    expect(f.request).toHaveBeenNthCalledWith(1, "sandbox.resolve", { agent_id: "a", session_id: "s", source: "", name: "" }, 10_000);
  });
  it("denies an absent or mismatched live caller before looking up a configuration", async () => {
    const f = fixture(); f.setUser("");
    await expect(f.authorization.authorize(identity, "s", operation, new AbortController().signal)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
    f.setUser("user-a");
    await expect(f.authorization.authorize({ ...identity, privateUserId: "user-b" }, "s", operation, new AbortController().signal)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("does not authorize a changed caller while control-plane authorization is pending", async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => { f.setUser("user-b"); return { user_id: "user-a" }; });
    await expect(f.authorization.authorize(identity, "s", operation, new AbortController().signal)).rejects.toThrow(/caller changed/);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("retains the shared published/preview materializer when tenant bindings are empty", async () => {
    const f = fixture();
    f.request.mockImplementation(async method => method === "sandbox.resolve" ? { user_id: "user-a" }
      : method === "config.getResources" ? { mcp_server_ids: null } : { mcpServers: { metrics: config } });
    await expect(f.authorization.authorize(identity, "s", operation, new AbortController().signal)).resolves.toMatchObject({ effect: "read" });
    expect(f.request).toHaveBeenCalledWith("config.getMcpServers", { agentId: "a", ids: [] }, 10_000);
  });
  it.each(["binding", "token", "namespace", "write", "unavailable"])("fails closed after %s changes", async kind => {
    const f = fixture(); let op = operation;
    if (kind === "binding") f.request.mockImplementation(async method => method === "sandbox.resolve" ? { user_id: "user-a" }
      : method === "config.getResources" ? { mcp_server_ids: [] } : { mcpServers: {} });
    if (kind === "token") f.request.mockImplementation(async method => method === "sandbox.resolve" ? { user_id: "user-a" }
      : method === "config.getResources" ? { mcp_server_ids: ["mcp-1"] } : { mcpServers: { metrics: { ...config, headers: { Authorization: "Bearer ROTATED" } } } });
    if (kind === "namespace") op = { ...operation, arguments: { tenant: "team-a", namespace: "default" } };
    if (kind === "write") op = { ...operation, name: "mutate", arguments: {} };
    if (kind === "unavailable") f.request.mockRejectedValue(new Error("upstream token=PRIVATE_TEST_MCP_TOKEN"));
    await expect(f.authorization.authorize(identity, "s", op, new AbortController().signal)).rejects.toThrow();
  });
});
