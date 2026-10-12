import path from "node:path";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { globSync } from "glob";
import { mcpDigest } from "../mcp-operation-policy.js";
import type { ToolResultArtifactStore } from "../tool-result-artifact.js";
import { GIT_QUERY_DESCRIPTOR, queryGit, type GitQueryParams } from "../../tools/code-view/git-query.js";
import { grepVirtual, type GrepParams } from "../../tools/code-view/grep.js";
import { CodeViewError, type CodeView, type VirtualLocation } from "../../tools/code-view/view.js";
import { createGlobFs } from "../../tools/code-view/glob-fs.js";

export const CODEX_CODE_SERVER = "siclaw_code";
const PAGE_CHARS = 16_000;
const MAX_PAGE_CHARS = 32_000;
const READ_BYTES = 256 * 1024;
const ARTIFACT_PREFIX = "siclaw_code:";
const filename = Type.String({ minLength: 1, maxLength: 4096, description: "Authorized virtual <repos dir>/<repo>@<sha>/<path>; resolve refs with git_query first" });
const integer = (minimum: number, maximum: number) => Type.Optional(Type.Integer({ minimum, maximum }));
const schemas: Record<string, TSchema> = {
  git_query: { ...GIT_QUERY_DESCRIPTOR.inputSchema, additionalProperties: false },
  code_read: Type.Object({ path: filename, offset: integer(1, Number.MAX_SAFE_INTEGER), limit: integer(1, 2000) }, { additionalProperties: false }),
  code_list: Type.Object({ path: filename, recursive: Type.Optional(Type.Boolean()), glob: Type.Optional(Type.String({ maxLength: 4096 })),
    offset: integer(0, Number.MAX_SAFE_INTEGER), limit: integer(1, 1000) }, { additionalProperties: false }),
  code_search: Type.Object({ path: filename, pattern: Type.String({ maxLength: 32768 }), literal: Type.Optional(Type.Boolean()),
    ignoreCase: Type.Optional(Type.Boolean()), glob: Type.Optional(Type.String({ maxLength: 4096 })),
    context: integer(0, 100), limit: integer(1, 1000) }, { additionalProperties: false }),
  code_result_read: Type.Object({ artifact_id: Type.String({ pattern: "^tra_[0-9a-f]{32}$" }), offset: integer(0, Number.MAX_SAFE_INTEGER),
    limit: integer(1, MAX_PAGE_CHARS) }, { additionalProperties: false }),
};
const descriptions: Record<string, string> = {
  git_query: GIT_QUERY_DESCRIPTOR.description,
  code_read: "Read a regular text file from the project's authorized virtual commit view. Returns the full immutable SHA. offset is a 1-based line (default 1); limit defaults to 200, maximum 2000. Byte-limited pages identify the next line; narrow a single oversized line. Physical files and bare mirrors are unavailable.",
  code_list: "List authorized commit entries in stable path order. recursive defaults false; glob filters paths. offset is a 0-based entry index, default 0; limit defaults to 100, maximum 1000. Returns full SHA, next_offset and complete. Excluded directories are invisible.",
  code_search: "Search text in an authorized virtual commit view using the shared Git grep implementation. literal, ignoreCase, glob and context follow the file search contract. limit defaults to 100, maximum 1000. Matching/stream/line limits are explicit; narrow the query when reached. Large delivered results can be read through code_result_read.",
  code_result_read: "Continue reading a code result artifact from this Agent/session. offset is a 0-based character position; limit defaults to 16000, maximum 32000. next_offset is null when complete. Original code capability and current repository/exclusion authorization remain required. Artifact pages cannot restore content already truncated by the original query.",
};

export interface CodexCodeConfig {
  view: CodeView;
  cwd: string;
  artifacts: ToolResultArtifactStore;
  recursiveList: boolean;
  allowed: { git_query: boolean; code_read: boolean; code_list: boolean; code_search: boolean };
}
type OwnedCall = { tool: string; threadId: string; turnId: string; args: Record<string, unknown>; used: boolean; controller: AbortController };
type Authority = { repo: string; rules: string; capability: string };

/** Concrete native product service. See docs/design/project-coding-native-engine-adaptation.md, Shared Code Services. */
export class CodexCode {
  readonly tools: Tool[];
  private readonly calls = new Map<string, OwnedCall>();
  private closed = false;

  constructor(private readonly options: CodexCodeConfig & {
    owns: (threadId: string, turnId: string) => boolean;
    projectArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
    redact: (text: string) => string;
    authorizeTool?: (name: string) => void;
  }) {
    const names = Object.entries(options.allowed).filter(([, allowed]) => allowed).map(([name]) => name);
    if (names.length) names.push("code_result_read");
    this.tools = names.map(name => ({ name, description: descriptions[name], inputSchema: JSON.parse(JSON.stringify(name === "code_list" && !options.recursiveList
        ? { ...schemas[name], properties: { ...schemas[name].properties, recursive: { type: "boolean", enum: [false] } } } : schemas[name])),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } }));
  }

  observe(event: { method: string; params: Record<string, any> }): void {
    const p = event.params, item = p.item;
    if (event.method === "item/completed" && typeof item?.id === "string") { this.remove(item.id); return; }
    if (event.method === "turn/completed") {
      for (const [id, call] of this.calls) if (call.threadId === p.threadId && call.turnId === (p.turnId ?? p.turn?.id)) this.remove(id);
      return;
    }
    if (this.closed || event.method !== "item/started" || item?.type !== "mcpToolCall" || item.server !== CODEX_CODE_SERVER ||
        typeof item.id !== "string" || !item.id || typeof p.threadId !== "string" || typeof p.turnId !== "string" ||
        this.calls.has(item.id) || this.calls.size >= 256 || !this.tools.some(tool => tool.name === item.tool) || !this.options.owns(p.threadId, p.turnId)) return;
    let args = item.arguments ?? {};
    try { if (typeof args === "string") args = JSON.parse(args); mcpDigest(args); } catch { return; }
    if (!args || typeof args !== "object" || Array.isArray(args)) return;
    this.calls.set(item.id, { tool: item.tool, threadId: p.threadId, turnId: p.turnId, args: structuredClone(args), used: false, controller: new AbortController() });
  }

  async call(args: Record<string, unknown>, callId: string, signal: AbortSignal, name: string) {
    try { return await this.dispatch(args, callId, signal, name); }
    catch (error) {
      const call = this.calls.get(callId);
      signal.throwIfAborted();
      if (!(error instanceof CodeViewError) || this.closed || !call || call.controller.signal.aborted || !this.options.owns(call.threadId, call.turnId)) throw error;
      return this.result({ error: true, reason: error.kind, message: this.options.redact(error.message) });
    }
  }

  private async dispatch(args: Record<string, unknown>, callId: string, signal: AbortSignal, name: string) {
    // Native item notifications and HTTP requests can arrive in either order.
    for (let i = 0; !this.calls.has(callId) && !this.closed && i < 100; i++) {
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const call = this.calls.get(callId);
    const check = () => {
      signal.throwIfAborted();
      if (this.closed || !call || this.calls.get(callId) !== call || call.controller.signal.aborted || call.tool !== name ||
          !this.options.owns(call.threadId, call.turnId) || mcpDigest(this.options.projectArguments?.(call.args) ?? call.args) !== mcpDigest(args))
        throw new Error("Code operation has no active owned turn or matching arguments");
      if (!this.tools.some(tool => tool.name === name)) throw new Error("Code capability is unavailable");
    };
    check();
    if (call!.used) throw new Error("Code call was already dispatched");
    if (!schemas[name] || !Value.Check(schemas[name], args)) throw new Error("Invalid code operation arguments");
    call!.used = true;
    const bounded = AbortSignal.any([signal, call!.controller.signal]);
    if (name === "code_result_read") {
      const full = await this.options.artifacts.readFull(args.artifact_id as string);
      if (!full.toolName.startsWith(ARTIFACT_PREFIX)) throw new Error("Artifact is not an authorized code result");
      const authority = JSON.parse(full.toolName.slice(ARTIFACT_PREFIX.length)) as Authority;
      this.checkAuthority(authority);
      const page = await this.options.artifacts.read(args.artifact_id as string, args.offset as number | undefined, args.limit as number | undefined);
      check(); this.checkAuthority(authority);
      return this.result({ artifact_id: page.reference.id, content: this.options.redact(page.text), offset: page.offset, next_offset: page.nextOffset, complete: page.complete });
    }
    const loc = name === "git_query" ? undefined : this.location(args.path as string);
    const repo = name === "git_query" ? (args.repo as string).trim() : loc!.repo.name;
    const authority = loc ? { repo, rules: JSON.stringify(loc.rules), capability: name } : this.authority(repo, name);
    this.checkAuthority(authority);
    let data: Record<string, unknown>;
    if (name === "git_query") {
      const output = await queryGit(this.options.view, args as unknown as GitQueryParams, bounded);
      data = { ...output.details, content: output.content[0].text, complete: output.details.truncated !== true };
    } else {
      const sha = await this.options.view.commit(loc!, bounded);
      if (name === "code_read") data = await this.read(loc!, args, bounded);
      else if (name === "code_list") data = await this.list(loc!, args, bounded);
      else {
        const output = await grepVirtual(this.options.view, loc!, path.resolve(this.options.cwd, args.path as string), args as unknown as GrepParams, bounded);
        data = { content: output.content[0].text, ...output.details,
          complete: !output.details?.truncation && !output.details?.matchLimitReached && !output.details?.linesTruncated };
      }
      data = { path: args.path, sha, ...data };
    }
    check(); this.checkAuthority(authority);
    const text = this.options.redact(JSON.stringify(data));
    if (text.length <= PAGE_CHARS) return this.result(JSON.parse(text));
    const captured = await this.options.artifacts.capture({ text, toolCallId: callId, toolName: ARTIFACT_PREFIX + JSON.stringify(authority) });
    check(); this.checkAuthority(authority);
    if ("failure" in captured) throw new Error(`Code result artifact could not be saved: ${captured.failure.reason}`);
    return this.result({ preview: text.slice(0, PAGE_CHARS), artifact_id: captured.reference.id, offset: 0,
      next_offset: PAGE_CHARS, complete: false, query_complete: data.complete, sha: data.sha, truncated: data.truncated,
      instruction: "Continue with code_result_read. Original query truncation cannot be recovered through artifact pages." });
  }

  private location(value: string): VirtualLocation {
    if (value.split(/[\\/]/).includes("..")) throw new Error("Code path traversal is not allowed");
    this.options.view.refreshAuthority();
    const loc = this.options.view.classify(path.resolve(this.options.cwd, value));
    if (!loc) throw new Error("Only authorized virtual repository commit paths are available");
    this.options.view.assertNotExcluded(loc, loc.rel);
    return loc;
  }
  private authority(repo: string, capability: string): Authority {
    this.options.view.refreshAuthority();
    return { repo, rules: JSON.stringify(this.options.view.requireRepository(repo).rules), capability };
  }
  private checkAuthority(saved: Authority): void {
    this.options.authorizeTool?.(saved.capability);
    if (!Object.hasOwn(this.options.allowed, saved.capability) || !this.options.allowed[saved.capability as keyof CodexCodeConfig["allowed"]])
      throw new Error("Original code capability is unavailable");
    if (this.authority(saved.repo, saved.capability).rules !== saved.rules) throw new Error("Repository rules changed; repeat the code query");
  }

  private async read(loc: VirtualLocation, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const raw = await this.options.view.readFile(loc, signal);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (text.includes("\0")) throw new Error("Code file is binary, not text");
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const offset = (args.offset as number | undefined) ?? 1, limit = (args.limit as number | undefined) ?? 200;
    const selected: string[] = [];
    let bytes = 0;
    for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > READ_BYTES) break;
      bytes += size; selected.push(line);
    }
    if (!selected.length && offset <= lines.length) throw new CodeViewError("too_large", "One code line exceeds the page byte budget; narrow the query with code_search");
    const next = offset + selected.length;
    return { content: selected.join("\n"), offset, next_offset: next <= lines.length ? next : null, complete: next > lines.length,
      ...(selected.length < Math.min(limit, Math.max(0, lines.length - offset + 1)) ? { truncated: "page_byte_budget" } : {}) };
  }

  private async list(loc: VirtualLocation, args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const view = this.options.view;
    let entries: Array<{ path: string; type: string }>;
    if (args.recursive) {
      if (!this.options.recursiveList) throw new Error("Recursive code listing capability is unavailable");
      await view.readDir(loc, loc.rel, signal);
      entries = (await view.listRecursive(loc, loc.rel, signal)).map(entry => ({ path: entry.rel, type: entry.type }));
    } else entries = (await view.readDir(loc, loc.rel, signal)).map(entry => ({ path: entry.name, type: entry.type }));
    if (typeof args.glob === "string") {
      const base = view.absolute(loc, loc.rel);
      const matches = new Set(globSync(args.glob, { cwd: base, absolute: true, dot: true,
        fs: createGlobFs(entries.map(entry => [path.join(base, entry.path), entry.type === "tree" ? "dir" : "file"])) }));
      entries = entries.filter(entry => matches.has(path.join(base, entry.path)));
    }
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const offset = (args.offset as number | undefined) ?? 0, limit = (args.limit as number | undefined) ?? 100;
    const page = entries.slice(offset, offset + limit), next = offset + page.length;
    return { entries: page, offset, next_offset: next < entries.length ? next : null, complete: next >= entries.length };
  }

  private result(data: Record<string, unknown>) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data, isError: data.error === true };
  }
  cancel(): void { for (const id of this.calls.keys()) this.remove(id); }
  close(): void { this.closed = true; this.cancel(); }
  private remove(id: string): void { this.calls.get(id)?.controller.abort(); this.calls.delete(id); }
}
