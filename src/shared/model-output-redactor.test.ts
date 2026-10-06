import { describe, expect, it } from "vitest";
import { createModelOutputRedactor, redactModelJson } from "./model-output-redactor.js";
import { McpModelSecurity, resolveMcpReadOnlyPolicy } from "../core/mcp-security.js";

describe("owner-scoped pre-model exact secret redaction", () => {
  it("covers short, quoted, encoded and placeholder-shaped known credentials", () => {
    const values = ["p@ss", 'quote"and\nnewline', "<Your API Key>"];
    const redact = createModelOutputRedactor(() => values);
    for (const value of values) for (const variant of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
      Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url"), Buffer.from(value).toString("hex")]) {
      expect(redact(`echo ${variant}`)).not.toContain(variant);
    }
    const safe = redactModelJson({ normal: 'quote"and\nnewline', keep: true }, redact);
    expect(safe).toEqual({ normal: "[REDACTED]", keep: true });
  });

  it("includes credentials acquired later and keeps user secret sets isolated", () => {
    const current: string[] = [];
    const first = createModelOutputRedactor(() => current);
    const second = createModelOutputRedactor(() => ["other-owner"]);
    expect(first("fresh-owner-token")).toBe("fresh-owner-token");
    current.push("fresh-owner-token");
    expect(first("fresh-owner-token")).toBe("[REDACTED]");
    expect(second("fresh-owner-token")).toBe("fresh-owner-token");
  });

  it("fails closed on excessive/unsupported output and does not accept annotation-only authority", () => {
    const security = new McpModelSecurity(() => ["known-secret"]);
    const policy = resolveMcpReadOnlyPolicy({ transport: "stdio", command: "untrusted" });
    expect(security.tool({ name: "write", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }, policy)).toBeUndefined();
    expect(() => resolveMcpReadOnlyPolicy({ transport: "stdio", command: "untrusted", env: { SICLAW_MCP_READ_ONLY_TOOLS: '["*"]' } })).toThrow();
    expect(security.result({ content: [{ type: "audio", data: "a25vd24tc2VjcmV0", mimeType: "audio/wav" }], _meta: { secret: "known-secret" } })).not.toHaveProperty("_meta");
    expect(JSON.stringify(security.result({ content: [{ type: "text", text: "known-secret".repeat(700_000) }] }))).not.toContain("known-secret");
    expect(security.result({ content: "known-secret" }).isError).toBe(true);
  });
});
