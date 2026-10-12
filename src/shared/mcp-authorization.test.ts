import { describe, expect, it } from "vitest";
import { mcpDigest } from "../core/mcp-operation-policy.js";
import { validateMcpPermit, type McpAuthorizationPermit, type McpOperation } from "./mcp-authorization.js";

const operation: McpOperation = { server: "devops", kind: "tool", name: "propose_deploy_run", arguments: { project: "p" },
  callId: "owned-call", configurationDigest: "a".repeat(64), effect: "write" };
const permit: McpAuthorizationPermit = { protocol: 1, effect: "write", agentId: "a", userId: "u", sessionId: "s",
  server: operation.server, kind: operation.kind, name: operation.name,
  argumentsDigest: mcpDigest(operation.arguments), configurationDigest: operation.configurationDigest, policyDigest: "b".repeat(64) };

describe("MCP permit effect and operation binding", () => {
  it("requires the declared effect and rejects cross-tool, argument and configuration substitution", () => {
    expect(validateMcpPermit(permit, operation)).toEqual(permit);
    for (const changed of [{ ...operation, effect: "read" as const }, { ...operation, name: "deploy_run" },
      { ...operation, arguments: { project: "other" } }, { ...operation, configurationDigest: "c".repeat(64) }]) {
      expect(() => validateMcpPermit(permit, changed)).toThrow();
    }
    expect(() => validateMcpPermit({ ...permit, effect: "read" }, operation)).toThrow();
  });
  it("does not grant writes to callers that did not declare them", () => {
    const readOperation = { ...operation };
    delete readOperation.effect;
    expect(() => validateMcpPermit(permit, readOperation)).toThrow();
    expect(validateMcpPermit({ ...permit, effect: "read" }, readOperation).effect).toBe("read");
  });
});
