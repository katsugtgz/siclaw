import { TextDecoder } from "node:util";
import { SensitiveLiteralStream, type SensitiveValueSource } from "../../shared/model-output-redactor.js";
import { createDocumentLineRedactor, redactDataDocument, sanitizeJSON } from "../../tools/infra/kubectl-sanitize.js";
import type { OutputAction } from "../../tools/infra/output-sanitizer.js";

const SUPPRESSED = "[Output record suppressed: unable to sanitize safely]";

/** Security framing, not process output retention. Native exec-server receives
 * only safe bytes and owns history, sequence numbers, polling and truncation.
 * A bounded JSON document is held until its structure is known; text records
 * flow immediately on newline. Oversized records are discarded independently. */
export class CodexOutputStream {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly literals: SensitiveLiteralStream;
  private readonly line: (line: string) => string;
  private pending = "";
  private json = false;
  private depth = 0;
  private quoted = false;
  private escape = false;
  private discarded = false;
  private suppressedBare = false;
  private failed = false;

  constructor(private readonly action: OutputAction | null = null,
    private readonly redact: (text: string) => string = text => text,
    source: SensitiveValueSource = () => [], private readonly recordBudget = 8 * 1024 * 1024) {
    this.literals = new SensitiveLiteralStream(source);
    this.line = createDocumentLineRedactor(action?.streamMode === "env");
  }

  push(bytes: Uint8Array): string {
    if (this.failed) return "";
    try { return this.consume(this.literals.push(this.decoder.decode(bytes, { stream: true }))); }
    catch { this.failed = true; this.pending = ""; return `${SUPPRESSED}\n`; }
  }

  finish(): string {
    if (this.failed) return "";
    try {
      const out = this.consume(this.literals.push(this.decoder.decode(), true));
      const tail = this.json || this.discarded ? this.pending || this.discarded ? SUPPRESSED : "" : this.safeRecord(this.pending);
      this.pending = "";
      return out + tail;
    } catch { this.failed = true; this.pending = ""; return `${SUPPRESSED}\n`; }
  }

  private consume(text: string): string {
    if (this.action && (!this.action.streamMode || this.action.streamMode === "suppress")) {
      if (!text || this.suppressedBare) return "";
      this.suppressedBare = true; return this.action.streamMode === "suppress" ? "**REDACTED**\n" : `${SUPPRESSED}\n`;
    }
    const output: string[] = [];
    for (const char of text) {
      if (!this.discarded) {
        this.pending += char;
        // UTF-16 length bounds memory; byte size is checked before the final gate.
        if (this.pending.length > this.recordBudget) { this.pending = ""; this.discarded = true; }
      }
      if (!this.json && this.pending.trimStart() === "{") { this.json = true; this.depth = 0; }
      // '[' also starts ordinary log prefixes. Decide after its next character.
      if (!this.json && /^\s*\[\s*(?:[\[{"\d\]-]|true|false|null)/.test(this.pending)) {
        this.json = true; this.depth = 1;
      }
      if (this.json) {
        if (this.quoted) {
          if (this.escape) this.escape = false;
          else if (char === "\\") this.escape = true;
          else if (char === '"') this.quoted = false;
        } else if (char === '"') this.quoted = true;
        else if (char === "{" || char === "[") this.depth++;
        else if (char === "}" || char === "]") this.depth--;
        if (this.depth === 0 && !this.quoted) {
          output.push(this.discarded ? SUPPRESSED : this.safeRecord(this.pending, true));
          this.reset();
        }
      } else if (char === (this.action?.streamMode === "env-nul" ? "\0" : "\n")) {
        output.push(this.discarded ? `${SUPPRESSED}${char}` : this.safeRecord(this.pending.slice(0, -1)) + char);
        this.reset();
      }
    }
    return output.join("");
  }

  private safeRecord(text: string, json = false): string {
    if (!text) return "";
    if (Buffer.byteLength(text) > this.recordBudget) return SUPPRESSED;
    if (json) {
      // Malformed structured data has no text fallback: kind/data/env fields
      // might occur after an already emitted value.
      try { JSON.parse(text); } catch { return SUPPRESSED; }
      text = this.action?.streamMode === "json" ? this.action.sanitize(text, () => {}) : sanitizeJSON(text, "pod", () => {});
      text = redactDataDocument(text).text;
    } else if (this.action?.streamMode === "json" && text.trim()) return SUPPRESSED;
    else if (this.action?.streamMode === "env-nul") text = this.action.sanitize(text, () => {});
    else text = this.line(text);
    return this.redact(text);
  }

  private reset(): void {
    this.pending = ""; this.json = false; this.depth = 0; this.quoted = false; this.escape = false; this.discarded = false;
  }
}
