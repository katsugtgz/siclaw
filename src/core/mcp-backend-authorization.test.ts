import { describe, expect, it } from "vitest";
import { McpModelSecurity, resolveMcpReadOnlyPolicy } from "./mcp-security.js";

describe("backend-authorized MCP discovery", () => {
  it("advertises only configured operations without relabeling writes or their retry semantics", () => {
    const policy = resolveMcpReadOnlyPolicy({ transport: "stdio", command: "unused", env: {
      SICLAW_MCP_OPERATION_POLICY: JSON.stringify({ version: 1, tools: {
        query: { effect: "read" },
        propose_deploy_run: { effect: "write", authorization: "backend" },
        deploy_run: { effect: "write" },
      } }),
    } });
    expect([...policy.tools]).toEqual(["query", "propose_deploy_run"]);
    const security = new McpModelSecurity(() => [], () => []);
    const inputSchema = { type: "object" as const };
    expect(security.tool({ name: "propose_deploy_run", inputSchema,
      annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false } }, policy)?.annotations)
      .toEqual({ readOnlyHint: false, idempotentHint: false, destructiveHint: false });
    expect(security.tool({ name: "deploy_run", inputSchema, annotations: { readOnlyHint: true } }, policy)).toBeUndefined();
    expect(security.tool({ name: "propose_unknown", inputSchema }, policy)).toBeUndefined();
  });
  it("preserves only explicitly reviewed public result strings while still hiding actual credentials", () => {
    const security = new McpModelSecurity(() => ["actual-backend-secret"], () => ["/private/credentials"]);
    const envelope = { proposals: [{ claim_token: "v1.public-confirmation-nonce.signature" }], token: "not-public",
      password: "private-password" };
    const paths = ["/proposals/0/claim_token"];
    const result = security.result({ content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope }, false, paths);
    expect(result.structuredContent?.proposals).toEqual(envelope.proposals);
    expect(JSON.parse((result.content[0] as { text: string }).text).proposals).toEqual(envelope.proposals);
    expect(JSON.stringify(result)).not.toContain("private-password");
    expect(JSON.stringify(result)).not.toContain("not-public");
    for (const value of ["actual-backend-secret", Buffer.from("actual-backend-secret").toString("base64"), "/private/credentials/key",
      `${Buffer.from(JSON.stringify({ token: "actual-backend-secret" })).toString("base64url")}.public-signature`,
      `${Buffer.from(JSON.stringify({ path: "/private/credentials/key" })).toString("base64url")}.public-signature`]) {
      const hidden = security.result({ content: [{ type: "text", text: JSON.stringify({ proposals: [{ claim_token: value }] }) }] }, false, paths, "write");
      expect(hidden.isError).toBe(true);
      expect(JSON.stringify(hidden)).not.toContain(value);
      expect(JSON.stringify(hidden)).toContain("Do not automatically repeat");
    }
    expect(JSON.stringify(security.result({ content: [], structuredContent: envelope }))).not.toContain(envelope.proposals[0].claim_token);
  });
});
