import fs from "node:fs";
import path from "node:path";
import { createKnowledgeCitationService, KNOWLEDGE_CITATION_DESCRIPTOR, type KnowledgeMountReceipt } from "../knowledge-citation-service.js";
import { parseArgs } from "../../tools/infra/command-sets.js";
import { CodexOutputStream } from "./codex-output-stream.js";
import { redactModelJson, type SensitiveValueSource } from "../../shared/model-output-redactor.js";
import { isSensitiveDataKey, redactDataDocument } from "../../tools/infra/kubectl-sanitize.js";
import type { KnowledgeSourceCitation } from "../../shared/knowledge-citations.js";

export const CODEX_KNOWLEDGE_SERVER = "siclaw_knowledge";

/** Knowledge is a selected local mount, not an external MCP resource catalogue. */
export function buildCodexKnowledgeReadInstructions(knowledgeDir: string): string {
  const index = JSON.stringify(path.join(knowledgeDir, "index.md"));
  return "Bound Siclaw knowledge bases are mounted local text files, not MCP resources. " +
    "Do not use list_mcp_resources or list_mcp_resource_templates to determine whether knowledge is available. " +
    `Use native exec_command in the siclaw environment to read the complete knowledge navigation file at ${index}, ` +
    "then read only the referenced pages for the requested bound library, following their relative links. " +
    "Use the navigation/library title to locate a requested knowledge base; do not require the user to provide a filesystem path. " +
    "Do not infer unavailability from an empty MCP catalogue. If the actual file read is refused or missing, report that result and stop; " +
    "do not guess, enumerate private directories or read credential/configuration files. " +
    "knowledge_cite registers citations after a verified page read; it is not the page-reading tool.";
}
type Scope = { threadId: string; turnId: string; service: ReturnType<typeof createKnowledgeCitationService>; bytes: number; unsafe: boolean };
type Read = { scope: Scope; receipt: KnowledgeMountReceipt; files: Array<{ path: string; raw: string }> };

/** Native read events establish provenance. The only product operation exposed
 * is citation registration; reading remains Codex's native filesystem/shell. */
export class CodexKnowledge {
  readonly tool = { name: "knowledge_cite", description: KNOWLEDGE_CITATION_DESCRIPTOR.description,
    inputSchema: JSON.parse(JSON.stringify(KNOWLEDGE_CITATION_DESCRIPTOR.inputSchema)),
    annotations: { readOnlyHint: true, destructiveHint: false } };
  private readonly scopes = new Map<string, Scope>();
  private readonly reads = new Map<string, Read>();
  private readonly calls = new Map<string, Scope>();
  private readonly waiters = new Map<string, () => void>();

  constructor(private readonly options: {
    knowledgeDir: string;
    owned: (threadId: string) => boolean;
    emit: (threadId: string, sources: KnowledgeSourceCitation[]) => void;
    redact: (text: string) => string;
    sensitiveValues: SensitiveValueSource;
  }) {
    try { this.options = { ...options, knowledgeDir: fs.realpathSync(options.knowledgeDir) }; }
    catch { /* A not-yet-materialized mount acquires no read receipts. */ }
  }

  observe(event: { method: string; params: Record<string, any> }): void {
    const p = event.params, threadId = p.threadId;
    if (typeof threadId !== "string" || !this.options.owned(threadId)) return;
    if (event.method === "turn/started" && typeof p.turn?.id === "string") {
      if (this.scopes.size >= 32 && !this.scopes.has(threadId)) return;
      const scope: Scope = { threadId, turnId: p.turn.id, bytes: 0, unsafe: false,
        service: createKnowledgeCitationService({ knowledgeDir: this.options.knowledgeDir, turnRef: { current: 1 },
          sessionEventEmitter: event => {
            const safe = event.sources.flatMap(source => {
              try {
                const url = new URL(source.url);
                if (url.username || url.password || [...url.searchParams.keys()].some(key => isSensitiveDataKey(key, "value"))) return [];
                if (this.options.redact(source.url) !== source.url) return [];
                return [redactModelJson(source, text => this.options.redact(redactDataDocument(text).text))];
              } catch { return []; }
            });
            if (safe.length !== event.sources.length) scope.unsafe = true;
            this.options.emit(threadId, safe);
          } }),
      };
      this.scopes.set(threadId, scope);
    }
    const scope = this.scopes.get(threadId);
    if (!scope || (p.turnId ?? p.turn?.id) !== scope.turnId) return;
    const item = p.item;
    if (event.method === "item/started" && item?.type === "mcpToolCall" && item.server === CODEX_KNOWLEDGE_SERVER && item.tool === "knowledge_cite") {
      this.calls.set(item.id, scope); this.waiters.get(item.id)?.();
    }
    if (event.method === "item/started" && item?.type === "commandExecution") {
      const files = this.captureFiles(item);
      const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.raw), 0);
      if (files.length && this.reads.size < 64 && scope.bytes + bytes <= 8 * 1024 * 1024) {
        scope.bytes += bytes;
        this.reads.set(item.id, { scope, files, receipt: scope.service.captureMount() });
      }
    }
    if (event.method === "item/completed" && item?.type === "commandExecution") {
      const read = this.reads.get(item.id); this.reads.delete(item.id);
      if (read && read.scope === scope && item.status === "completed" && item.exitCode === 0 && typeof item.aggregatedOutput === "string") {
        try {
          const stream = new CodexOutputStream(null, this.options.redact, this.options.sensitiveValues);
          const expected = stream.push(Buffer.from(read.files.map(file => file.raw).join(""))) + stream.finish();
          // Truncated/partial, modified and transformed output establishes no full-page receipt.
          if (expected !== item.aggregatedOutput) return;
          for (const file of read.files) {
            if (fs.readFileSync(file.path, "utf8") === file.raw) scope.service.noteRead(file.path, file.raw, read.receipt);
          }
        } catch { /* Unverified bytes never become citation authority. */ }
      }
    }
    if (event.method === "item/completed" && item?.type === "mcpToolCall") this.calls.delete(item.id);
    if (event.method === "turn/completed") this.end(threadId);
  }

  async call(args: Record<string, unknown>, callId: string, signal: AbortSignal) {
    if (!this.calls.has(callId)) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); this.waiters.delete(callId); resolve(); };
      const timer = setTimeout(done, 2_000); this.waiters.set(callId, done);
      signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
    });
    const scope = this.calls.get(callId);
    if (signal.aborted || !scope || this.scopes.get(scope.threadId) !== scope || !this.options.owned(scope.threadId)) {
      return { isError: true, content: [{ type: "text" as const, text: "Knowledge citation request has no active owning turn." }] };
    }
    const normalize = (value: unknown) => {
      if (typeof value !== "string") return value;
      const hash = value.lastIndexOf("#"), filename = hash > 0 ? value.slice(0, hash) : value;
      try {
        const canonical = fs.realpathSync(path.resolve(this.options.knowledgeDir, filename));
        if (canonical.startsWith(this.options.knowledgeDir + path.sep)) return canonical + (hash > 0 ? value.slice(hash) : "");
      } catch { /* Invalid/unread paths remain invalid for the shared validator. */ }
      return value;
    };
    const normalized = { ...args,
      ...(Array.isArray(args.evidence_refs) ? { evidence_refs: args.evidence_refs.map(normalize) } : {}),
      ...(Array.isArray(args.pages) ? { pages: args.pages.map(page => page && typeof page === "object" && !Array.isArray(page)
        ? { ...page, path: normalize((page as Record<string, unknown>).path) } : page) } : {}),
    };
    const result = scope.service.register(normalized);
    if (scope.unsafe) return { isError: true, content: [{ type: "text" as const, text: "Knowledge source metadata could not be delivered safely. No usable citations are available for this turn." }] };
    return { content: result.content, structuredContent: { ...result.details, message: result.content[0].text },
      isError: result.details.cited === 0 && !/already registered|no trusted clickable|no unique original/i.test(result.content[0].text) };
  }

  end(threadId: string): void {
    this.scopes.delete(threadId);
    for (const [id, read] of this.reads) if (read.scope.threadId === threadId) this.reads.delete(id);
    for (const [id, scope] of this.calls) if (scope.threadId === threadId) { this.calls.delete(id); this.waiters.get(id)?.(); }
  }
  close(): void { for (const threadId of this.scopes.keys()) this.end(threadId); for (const finish of this.waiters.values()) finish(); }

  private captureFiles(item: Record<string, any>): Array<{ path: string; raw: string }> {
    try {
      let args = parseArgs(String(item.command));
      if (args.length === 3 && ["/bin/bash", "/bin/sh", "/bin/zsh"].includes(args[0]) && ["-c", "-lc"].includes(args[1])) args = parseArgs(args[2]);
      if (!["cat", "head", "tail"].includes(args[0]) || args.length < 2 || args.length > 20) return [];
      const files: string[] = [];
      for (let index = 1; index < args.length; index++) {
        const arg = args[index];
        if (args[0] !== "cat" && ["-n", "-c"].includes(arg) && /^\d{1,7}$/.test(args[index + 1] ?? "")) { index++; continue; }
        if (arg.startsWith("-") || files.length >= 16) return [];
        files.push(arg);
      }
      if (!files.length) return [];
      const root = fs.realpathSync(this.options.knowledgeDir);
      return files.map(value => {
        const filename = path.resolve(item.cwd, value);
        if (fs.lstatSync(filename).isSymbolicLink()) throw new Error();
        const canonical = fs.realpathSync(filename);
        if (!canonical.startsWith(root + path.sep) || !canonical.endsWith(".md") || fs.statSync(canonical).size > 512 * 1024) throw new Error();
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(canonical));
        return { path: canonical, raw };
      });
    } catch { return []; }
  }
}
