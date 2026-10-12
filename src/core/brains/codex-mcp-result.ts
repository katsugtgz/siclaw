import { createModelOutputRedactor } from "../../shared/model-output-redactor.js";
import { redactDataDocument } from "../../tools/infra/kubectl-sanitize.js";

/** Native MCP results and error-only items share one public projection. */
export function projectCodexMcpResult(item: Record<string, any>,
  redact: (text: string) => string = createModelOutputRedactor(), externalMcp = false) {
  const result = item.result && typeof item.result === "object" ? item.result : {};
  const isError = item.status !== "completed" || result.isError === true || !!item.error;
  let content = Array.isArray(result.content) ? result.content : [];
  if (isError && (item.error || !content.length)) {
    const reason = typeof item.error === "string" ? item.error : item.error?.message;
    let text = "Native MCP operation failed.";
    if (typeof reason === "string" && reason) {
      try { text = redact(redactDataDocument(reason).text).slice(0, 16 * 1024); }
      catch { text = "Native MCP operation failed; error details were suppressed."; }
    }
    if (!content.some((block: any) => block.type === "text" && block.text === text)) content = [...content, { type: "text", text }];
  }
  return { content, details: externalMcp ? { structuredContent: result.structuredContent } : result.structuredContent, isError };
}
