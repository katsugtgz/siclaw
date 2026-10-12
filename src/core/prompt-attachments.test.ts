import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { materializePromptFiles, attachmentText } from "./prompt-attachments.js";
import { createModelOutputRedactor } from "../shared/model-output-redactor.js";

describe("shared attachment evidence", () => {
  const redact = createModelOutputRedactor(() => ["owner-secret"]);
  it("mounts sanitized documents and cannot use a filename as a path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-"));
    try {
      const raw = '{"kind":"Secret","data":{"key":"c2VjcmV0"},"note":"owner-secret"}';
      const [file] = await materializePromptFiles([{ filename: "../../escape.json", mimeType: "application/json", data: Buffer.from(raw).toString("base64") }], root, redact);
      expect(path.dirname(file)).toBe(root); expect(fs.readFileSync(file, "utf8")).not.toMatch(/owner-secret|c2VjcmV0/);
      expect(fs.readFileSync(file, "utf8")).toContain("REDACTED"); expect(fs.statSync(file).mode & 0o222).toBe(0);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects malformed base64, invalid UTF8 and opaque binary files", async () => {
    for (const data of ["bad-base64!", Buffer.from([0xff]).toString("base64"), Buffer.from("x\0y").toString("base64")])
      await expect(attachmentText({ filename: "x.log", mimeType: "text/plain", data }, redact)).rejects.toThrow();
    await expect(attachmentText({ filename: "x", mimeType: "application/octet-stream", data: "aGk=" }, redact)).rejects.toThrow();
  });
  it("uses the existing OCR wire contract and sanitizes its untrusted output", async () => {
    vi.stubEnv("SICLAW_OCR_BACKEND_URL", "http://fixture/parse");
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "password: owner-secret\nstatus: safe evidence" })));
    vi.stubGlobal("fetch", fetch);
    try {
      const text = await attachmentText({ filename: "runbook.pdf", mimeType: "application/pdf", data: "aGk=" }, redact);
      expect(text).toContain("safe evidence"); expect(text).not.toContain("owner-secret");
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ expected_output: "siclaw_screenshot_evidence_v1", source: { type: "file_base64" } });
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });
});
