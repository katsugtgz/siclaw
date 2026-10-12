import { describe, expect, it, vi } from "vitest";
import { CodexMcpAuthorization } from "./codex-mcp-authorization.js";
import { mcpDigest } from "../mcp-operation-policy.js";
import type { McpOperation, McpAuthorizationPermit } from "../../shared/mcp-authorization.js";

const operation: McpOperation = { server: "metrics", kind: "tool", name: "query", arguments: { namespace: "sicore-test" }, callId: "call-1", configurationDigest: "a".repeat(64) };
const permit: McpAuthorizationPermit = { protocol: 1, effect: "read", agentId: "a", userId: "u", sessionId: "s", server: "metrics", kind: "tool",
  name: "query", argumentsDigest: mcpDigest(operation.arguments), configurationDigest: operation.configurationDigest, policyDigest: "b".repeat(64) };
const event = (id = "call-1", threadId = "root", args: unknown = operation.arguments) => ({ method: "item/started", params: { threadId, turnId: "turn",
  item: { id, type: "mcpToolCall", server: "metrics", tool: "query", arguments: args } } });
function fixture() {
  let active = true;
  const authorize = vi.fn(async () => permit);
  const gateway = new CodexMcpAuthorization({ owns: id => active && id === "root", projectArguments: (_server, _name, args) => args, authorize });
  return { gateway, authorize, end: () => { active = false; gateway.cancel(); } };
}
describe("owned native MCP call attribution", () => {
  it("binds an exact native item once and rechecks its authority before result delivery", async () => {
    const f = fixture(); f.gateway.observe(event());
    expect(await f.gateway.authorize(operation, new AbortController().signal, "before")).toEqual(permit);
    await expect(f.gateway.authorize(operation, new AbortController().signal, "before")).rejects.toThrow(/already/);
    expect(await f.gateway.authorize(operation, new AbortController().signal, "after")).toEqual(permit);
    f.end();
    await expect(f.gateway.authorize(operation, new AbortController().signal, "after")).rejects.toThrow();
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it("waits for native notification/HTTP reordering without granting unknown calls", async () => {
    const f = fixture();
    const pending = f.gateway.authorize(operation, new AbortController().signal, "before");
    f.gateway.observe(event()); await expect(pending).resolves.toEqual(permit);
    f.gateway.close();
    await expect(f.gateway.authorize({ ...operation, callId: "forged" }, new AbortController().signal, "before")).rejects.toThrow();
  });
  it("rejects substituted arguments, server, operation and unauthorized child threads", async () => {
    const f = fixture(); f.gateway.observe(event());
    for (const op of [{ ...operation, arguments: { namespace: "prod" } }, { ...operation, server: "other" }, { ...operation, name: "mutate" }]) {
      await expect(f.gateway.authorize(op, new AbortController().signal, "before")).rejects.toThrow(/owned/);
    }
    f.gateway.observe(event("foreign", "not-owned"));
    const controller = new AbortController(); controller.abort();
    await expect(f.gateway.authorize({ ...operation, callId: "foreign" }, controller.signal, "before")).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled(); f.gateway.close();
  });
  it("cancels pending Runtime authorization when its native item ends", async () => {
    const f = fixture(); f.gateway.observe(event());
    f.authorize.mockImplementation(async () => { f.end(); return permit; });
    await expect(f.gateway.authorize(operation, new AbortController().signal, "before")).rejects.toThrow();
  });
});
