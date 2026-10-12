import { describe, expect, it } from "vitest";
import { projectCodexMcpResult } from "./codex-mcp-result.js";
import { createModelOutputRedactor } from "../../shared/model-output-redactor.js";
describe("native MCP error result projection", () => {
  it("preserves sanitized error-only reasons", () => {
    const output = projectCodexMcpResult({ status: "failed", error: { message: "Backend rejected private-live-key\npassword: hidden\n" } },
      createModelOutputRedactor(() => ["private-live-key"]));
    expect(output.isError).toBe(true); expect(output.content[0].text).toContain("Backend rejected");
    expect(output.content[0].text).not.toMatch(/private-live-key|hidden/);
  });
  it("does not replace valid result contents and fails closed if the gate fails", () => {
    expect(projectCodexMcpResult({ status: "completed", result: { content: [{ type: "text", text: "healthy" }], structuredContent: { ok: true } } }))
      .toMatchObject({ isError: false, details: { ok: true }, content: [{ text: "healthy" }] });
    const failed = projectCodexMcpResult({ status: "failed", error: { message: "private raw reason" } }, () => { throw new Error(); });
    expect(failed.content[0].text).toContain("suppressed"); expect(failed.content[0].text).not.toContain("private raw reason");
  });
  it("matches Pi external MCP metadata without changing intrinsic product details", () => {
    const item = { status: "completed", result: { content: [], structuredContent: { items: [{ claim_token: "public-confirmation" }] } } };
    expect(projectCodexMcpResult(item, undefined, true).details).toEqual({ structuredContent: item.result.structuredContent });
    expect(projectCodexMcpResult(item).details).toEqual(item.result.structuredContent);
  });
});
