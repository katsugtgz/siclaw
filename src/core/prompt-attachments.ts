import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PromptFile } from "./brain-session.js";
import { redactDataDocument } from "../tools/infra/kubectl-sanitize.js";

export const TEXT_ATTACHMENT_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "text/yaml", "text/x-yaml",
  "application/json", "application/yaml", "application/x-yaml", "application/xml", "text/xml", "text/x-log"]);
export const PROMPT_FILE_MIMES = new Set(["application/pdf", ...TEXT_ATTACHMENT_MIMES]);

/** Request data and OCR are untrusted evidence. Raw documents are never placed
 * in the native filesystem; only validated, sanitized UTF-8 text is mounted. */
export async function attachmentText(file: PromptFile, redact: (text: string) => string): Promise<string> {
  if (!PROMPT_FILE_MIMES.has(file.mimeType) || file.data.length > 8 * 1024 * 1024 ||
      file.data.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new Error("Invalid attachment data");
  let text: string; let prefix = "";
  if (file.mimeType === "application/pdf") {
    // Same OCR deployment/contract used at the product attachment boundary.
    const url = process.env.SICLAW_OCR_BACKEND_URL;
    if (!url) throw new Error("PDF text extraction requires the configured attachment OCR service");
    const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(150_000),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: randomUUID(), input: file.filename,
        kind_hint: "pdf", language_hint: "auto", expected_output: "siclaw_screenshot_evidence_v1",
        source: { type: "file_base64", filename: file.filename, mime_type: file.mimeType, data: file.data } }) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Attachment OCR service failed"); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break;
        bytes += part.value.length; if (bytes > 8 * 1024 * 1024) throw new Error("Attachment OCR output exceeds the security budget"); chunks.push(part.value); }
    } finally { await reader.cancel(); }
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (typeof result.text !== "string" || !result.text.trim()) throw new Error("Attachment OCR returned no readable text");
    prefix = "[PDF text extracted by OCR; layout and recognition may be incomplete]\n";
    text = result.text;
  } else {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(file.data, "base64"));
    if (text.includes("\0")) throw new Error("Binary attachments are not supported");
  }
  return prefix + redact(redactDataDocument(text).text);
}

export async function materializePromptFiles(files: PromptFile[], directory: string, redact: (text: string) => string): Promise<string[]> {
  if (files.length > 4) throw new Error("At most four attachments are supported");
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Attachment directory must not be a link");
  // Validate every document before publishing any of them.
  const texts = await Promise.all(files.map(file => attachmentText(file, redact)));
  return files.map((file, i) => {
    const name = path.basename(redact(file.filename).replaceAll("\\", "/")).replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 120) || "attachment";
    const target = path.join(directory, `${randomUUID()}-${name}${file.mimeType === "application/pdf" ? ".txt" : ""}`);
    fs.writeFileSync(target, texts[i], { flag: "wx", mode: 0o444 });
    return target;
  });
}
