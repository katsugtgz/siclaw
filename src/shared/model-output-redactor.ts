import { buildRedactionConfig, redactText } from "./output-redactor.js";

/** Owner-scoped, live secret lookup. Never use a process-global secret set:
 * LocalSpawner hosts unrelated users in the same Node process. */
export type SensitiveValueSource = () => readonly string[];

const MAX_SECRET_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/** Shared exact-value vocabulary for document and stream gates. */
export function sensitiveValueLiterals(source: SensitiveValueSource): string[] {
  const values = [...new Set(source().filter(value => typeof value === "string" && value.length > 0))];
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_SECRET_BYTES) throw new Error("Secret set exceeds the redaction budget");
  const expanded = new Set<string>();
  for (const value of values) for (const variant of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
    Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url"), Buffer.from(value).toString("hex")]) expanded.add(variant);
  return [...expanded].sort((left, right) => right.length - left.length);
}

/** Hold only a possible credential suffix, including credentials containing
 * newlines. No emitted byte can later become part of a known credential. */
export class SensitiveLiteralStream {
  private pending = "";
  constructor(private readonly source: SensitiveValueSource = () => []) {}
  push(text: string, final = false): string {
    this.pending += text;
    const literals = sensitiveValueLiterals(this.source);
    let cut = this.pending.length;
    if (!final) {
      for (const literal of literals) {
        const first = Math.max(0, this.pending.length - literal.length + 1);
        for (let at = this.pending.indexOf(literal[0], first); at >= 0; at = this.pending.indexOf(literal[0], at + 1)) {
          if (literal.startsWith(this.pending.slice(at))) { cut = Math.min(cut, at); break; }
        }
      }
      // A complete shorter/overlapping value must not straddle the suffix held
      // for another credential. Move the boundary before that complete value.
      let moved: boolean;
      do {
        moved = false;
        for (const literal of literals) {
          const at = this.pending.lastIndexOf(literal, cut - 1);
          if (at >= 0 && at < cut && at + literal.length > cut) { cut = at; moved = true; }
        }
      } while (moved);
    }
    let safe = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    for (const literal of literals) safe = safe.split(literal).join("[REDACTED]");
    return safe;
  }
}

/** Exact values take precedence over heuristics (including short passwords and
 * placeholder-shaped credentials). Cover common transport encodings as well.
 * This does not claim to detect arbitrary malicious encodings. */
export function createModelOutputRedactor(source: SensitiveValueSource = () => []): (text: string) => string {
  let signature = "";
  let literals: string[] = [];
  const generic = buildRedactionConfig();
  return (text) => {
    if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new Error("Output exceeds the redaction budget");
    const values = [...new Set(source().filter(value => typeof value === "string" && value.length > 0))];
    const next = JSON.stringify(values);
    if (Buffer.byteLength(next) > MAX_SECRET_BYTES) throw new Error("Secret set exceeds the redaction budget");
    if (next !== signature) {
      signature = next;
      literals = sensitiveValueLiterals(() => values);
    }
    let safe = text;
    for (const literal of literals) safe = safe.split(literal).join("[REDACTED]");
    return redactText(safe, generic);
  };
}

/** Redact values AND keys without invalidating JSON. Bound hostile depth/size
 * before traversing. Failures must be handled by suppressing the entire result. */
export function redactModelJson<T>(value: T, redact: (text: string) => string): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_DOCUMENT_BYTES) {
    throw new Error("Invalid or oversized model output");
  }
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 48) throw new Error("Model output exceeds the structure budget");
    if (typeof item === "string") return redact(item);
    if (Array.isArray(item)) return item.map(entry => visit(entry, depth + 1));
    if (item !== null && typeof item === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, entry] of Object.entries(item)) result[redact(key)] = visit(entry, depth + 1);
      return result;
    }
    return item;
  };
  return visit(value, 0) as T;
}
