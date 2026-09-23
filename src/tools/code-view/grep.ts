/**
 * `grep` over a virtual `<repo>@<sha>` path.
 *
 * pi's grep cannot be steered through its operations: it spawns ripgrep on the
 * real filesystem itself and only asks the operations whether the path is a
 * directory and, for context lines, what a file contains. So — following the
 * `withGrepPathReason` precedent in agent-factory — the tool's `execute` is
 * wrapped: a physical path goes to pi untouched, a virtual one is answered here
 * with `git grep` against the commit.
 *
 * 🔴 The output contract is pi's, reproduced step by step (see pi 0.85.1
 * `dist/core/tools/grep.js`), because the agent must be able to use one tool
 * the same way on `app@latest` and on `app@<sha>`:
 *
 *   rg flag / behaviour                    here
 *   ─────────────────────────────────────  ─────────────────────────────────────
 *   Rust regex                             `-P` (PCRE, the closest dialect)
 *   --fixed-strings                        `-F`
 *   --ignore-case                          `-i`
 *   --hidden (dotfiles searched)           every tracked file is searched
 *   binary files skipped                   `-I`
 *   --glob, no `/`: matches the basename   the same test, run by `glob` itself
 *   --glob with `/`: anchored at rg's      the same anchoring: rg is spawned
 *     CWD (the process's, not the search     without a cwd, so it inherits
 *     path)                                  process.cwd()
 *   --glob '!x': excludes x (and a         excludes the file when it or an
 *     directory matching x, pruned)          ancestor below the search path matches
 *   explicit FILE path: --glob ignored     ignored
 *   paths relative to the search dir,      identical `formatPath`
 *     basename for a file
 *   per-match context block from the       identical `formatBlock`, reading the
 *     file (`-` / `:` markers)               blob from the same commit
 *   stop the child at `limit` matches      stop `git grep` at `limit` matches
 *   notices + details                      identical text and fields
 *
 * The contract test (`grep.test.ts`) runs the same queries over a physical tree
 * (real ripgrep through pi's tool) and the equivalent commit, and requires
 * byte-identical output. It is what fails first when pi is upgraded.
 *
 * Known, documented differences: PCRE is not Rust regex at the edges (lookaround
 * works here and not in rg; Unicode classes differ under `LC_ALL=C`); `.ignore`
 * files that rg would honour are not; a symlink's target text is searched by
 * git where rg (not following links) skips it; ordering is git's (path order)
 * where rg's multi-threaded walk has none.
 */
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { globSync } from "glob";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { GIT_DEFAULT_MAX_OUTPUT_BYTES, runGit, streamGit } from "./git.js";
import { excludePathspecs, type CodeView, type VirtualLocation } from "./view.js";
import { createGlobFs } from "./glob-fs.js";

/**
 * pi's grep constants that its package does not export. Both are pinned by the
 * contract test (a >100-match query without `limit`, and a >500-char line), so
 * an upgrade that changes either fails there rather than drifting silently.
 */
const PI_GREP_DEFAULT_LIMIT = 100;
const PI_GREP_MAX_LINE_LENGTH = 500;

/** Past this much `git grep` output without reaching the match limit, stop and say so. */
const GREP_STREAM_CAP_BYTES = GIT_DEFAULT_MAX_OUTPUT_BYTES;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * pi's `resolveToCwd` (not exported): unicode spaces → " ", a leading `@`
 * dropped, `~` expanded, `file://` URLs converted, then resolved against cwd.
 * Must agree with pi exactly — the wrapper decides physical-vs-virtual on the
 * path pi WOULD search.
 */
export function resolveToolPath(input: string, cwd: string): string {
  let p = input.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
}

export interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

// ── rg --glob semantics, answered by `glob` ─────────────────────────────────

type Kind = "dir" | "file";

/**
 * One rg `--glob` value, compiled into a predicate over absolute paths.
 *
 * rg globs are gitignore-flavoured: no `/` (a trailing one aside) matches the
 * BASENAME at any depth; a `/` at the start or in the middle anchors the glob
 * to rg's working directory — which, because pi spawns rg without a `cwd`, is
 * this process's cwd, NOT the search path. A trailing `/` restricts the glob to
 * directories. The matching itself is delegated to `glob` over a one-path
 * filesystem (glob-fs.ts), so `*`, `?`, `[…]`, `{a,b}` and `**` are one library's semantics
 * rather than a second hand-written matcher.
 */
export function compileRgGlob(raw: string, processCwd: string) {
  const negated = raw.startsWith("!");
  let g = negated ? raw.slice(1) : raw;
  const dirOnly = g.endsWith("/");
  if (dirOnly) g = g.replace(/\/+$/, "");
  const anchored = g.includes("/");
  if (anchored) g = g.replace(/^\/+/, "");
  const cache = new Map<string, boolean>();
  const matches = (abs: string, kind: Kind): boolean => {
    if (dirOnly && kind !== "dir") return false;
    const key = anchored ? `${kind}\0${abs}` : `${kind}\0${path.basename(abs)}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const cwd = anchored ? processCwd : path.dirname(abs);
    const found = globSync(g, { cwd, absolute: true, dot: true, nocase: false, fs: createGlobFs([[abs, kind]]) }).includes(abs);
    cache.set(key, found);
    return found;
  };
  return {
    negated,
    /** Pushdown-safe basename glob: plain characters plus `*` / `?` only. */
    simpleBasename: !negated && !anchored && !dirOnly && /^[A-Za-z0-9._*?-]+$/.test(g) ? g : null,
    /** Should this file (below `searchRoot`) be searched? */
    accepts(fileAbs: string, searchRoot: string): boolean {
      if (!negated) return matches(fileAbs, "file");
      if (matches(fileAbs, "file")) return false;
      // A negated glob that matches a DIRECTORY prunes everything below it — but
      // only directories rg walked into, i.e. strictly below the search root.
      for (let d = path.dirname(fileAbs); d.startsWith(searchRoot + path.sep); d = path.dirname(d)) {
        if (matches(d, "dir")) return false;
      }
      return true;
    },
  };
}

// ── git grep -z output ───────────────────────────────────────────────────────

/**
 * Incremental parser for `git grep -z -n`: `<tree>:<path>\0<line>\0<text>\n`.
 * Split on bytes before decoding (a path may contain `:` or even `\n`).
 */
class GitGrepParser {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly onMatch: (file: string, line: number, text: string) => void) {}
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const a = this.buf.indexOf(0);
      if (a === -1) return;
      const b = this.buf.indexOf(0, a + 1);
      if (b === -1) return;
      const c = this.buf.indexOf(0x0a, b + 1);
      if (c === -1) return;
      const file = this.buf.subarray(0, a).toString("utf8");
      const line = Number(this.buf.subarray(a + 1, b).toString("ascii"));
      const text = this.buf.subarray(b + 1, c).toString("utf8");
      this.buf = this.buf.subarray(c + 1);
      this.onMatch(file, line, text);
    }
  }
}

function escapeGlobMagic(s: string): string {
  return s.replace(/[*?[\]\\]/g, "\\$&");
}

/** One virtual grep, returning exactly what pi's grep would return for the same tree. */
export async function grepVirtual(
  view: CodeView,
  loc: VirtualLocation,
  searchPath: string,
  params: GrepParams,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined }> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const { pattern, glob, ignoreCase, literal, context, limit } = params;

  // pi: isDirectory(searchPath), a failure of which is "Path not found" — here
  // the specific reason instead.
  view.assertNotExcluded(loc, loc.rel);
  const found = await view.lookup(loc, loc.rel, signal);
  if (!found) throw view.pathNotFound(loc, loc.rel);
  const isDirectory = found.kind === "root" || found.entry.type !== "blob";
  if (!isDirectory) await view.fileEntry(loc, signal); // symlink / size refusals, as read gives them
  const commit = await view.commit(loc, signal);

  const contextValue = context && context > 0 ? context : 0;
  const effectiveLimit = Math.max(1, limit ?? PI_GREP_DEFAULT_LIMIT);
  const formatPath = (filePath: string) => {
    if (isDirectory) {
      const relative = path.relative(searchPath, filePath);
      if (relative && !relative.startsWith("..")) return relative.replace(/\\/g, "/");
    }
    return path.basename(filePath);
  };

  // pathspecs: the search scope, an optional safe glob pushdown, the exclusions.
  // The glob pushdown only NARROWS what git reads; `rgGlob.accepts` below stays
  // the arbiter, so a pushdown can never add a result rg would not have.
  const rgGlob = glob && isDirectory ? compileRgGlob(glob, process.cwd()) : null;
  const pathspecs: string[] = [];
  if (!isDirectory) {
    pathspecs.push(`:(literal)${loc.rel}`);
  } else if (rgGlob?.simpleBasename) {
    pathspecs.push(`:(glob)${loc.rel ? `${escapeGlobMagic(loc.rel)}/` : ""}**/${rgGlob.simpleBasename}`);
  } else if (loc.rel) {
    pathspecs.push(`:(literal)${loc.rel}/`);
  }
  pathspecs.push(...excludePathspecs(loc.rules));

  const args = ["grep", "-z", "-n", "-I", "--no-color", "--no-textconv", literal ? "-F" : "-P"];
  if (ignoreCase) args.push("-i");
  args.push("-e", pattern, commit, "--", ...pathspecs);

  const matches: Array<{ filePath: string; lineNumber: number; lineText: string }> = [];
  let matchCount = 0;
  let matchLimitReached = false;
  let streamed = 0;
  let overCap = false;
  const prefix = `${commit}:`;
  const accepted = new Map<string, boolean>();
  const parser = new GitGrepParser((file, lineNumber, lineText) => {
    if (matchCount >= effectiveLimit) return;
    const rel = file.startsWith(prefix) ? file.slice(prefix.length) : file;
    const filePath = view.absolute(loc, rel);
    if (rgGlob) {
      let ok = accepted.get(filePath);
      if (ok === undefined) {
        ok = rgGlob.accepts(filePath, searchPath);
        accepted.set(filePath, ok);
      }
      if (!ok) return;
    }
    matchCount++;
    matches.push({ filePath, lineNumber, lineText });
    if (matchCount >= effectiveLimit) {
      matchLimitReached = true;
      handle.stop();
    }
  });
  const handle = streamGit(loc.repo.gitDir, args, {
    signal,
    onStdout: (chunk) => {
      streamed += chunk.length;
      if (streamed > GREP_STREAM_CAP_BYTES) {
        overCap = true;
        handle.stop();
        return;
      }
      parser.push(chunk);
    },
  });
  const { exitCode, stderr, stopped } = await handle.done;
  if (overCap) {
    throw new Error(
      `git grep produced over ${formatSize(GREP_STREAM_CAP_BYTES)} of output before reaching ${effectiveLimit} ` +
      `matches; narrow the search with path or glob`,
    );
  }
  if (!stopped && exitCode !== 0 && exitCode !== 1) {
    throw new Error(stderr.trim() || `git grep exited with code ${exitCode}`);
  }
  if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

  // Context blocks, formatted exactly as pi's formatBlock does (one block per
  // match, overlapping blocks repeated), from the blob at the same commit.
  const fileCache = new Map<string, string[]>();
  const getFileLines = async (filePath: string): Promise<string[]> => {
    let lines = fileCache.get(filePath);
    if (!lines) {
      const rel = path.relative(loc.root, filePath).split(path.sep).join("/");
      const { stdout, truncated } = await runGit(loc.repo.gitDir, ["cat-file", "blob", `${commit}:${rel}`], { signal });
      if (truncated) throw new Error(`"${rel}" is too large to show context lines for; retry with context 0`);
      lines = stdout.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      fileCache.set(filePath, lines);
    }
    return lines;
  };
  let linesTruncated = false;
  const outputLines: string[] = [];
  for (const match of matches) {
    const relativePath = formatPath(match.filePath);
    if (contextValue === 0) {
      const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
      const { text, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(`${relativePath}:${match.lineNumber}: ${text}`);
      continue;
    }
    const lines = await getFileLines(match.filePath);
    if (!lines.length) {
      outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
      continue;
    }
    const start = Math.max(1, match.lineNumber - contextValue);
    const end = Math.min(lines.length, match.lineNumber + contextValue);
    for (let current = start; current <= end; current++) {
      const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
      const { text, wasTruncated } = truncateLine(sanitized);
      if (wasTruncated) linesTruncated = true;
      outputLines.push(current === match.lineNumber ? `${relativePath}:${current}: ${text}` : `${relativePath}-${current}- ${text}`);
    }
  }

  const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  const details: Record<string, unknown> = {};
  const notices: string[] = [];
  if (matchLimitReached) {
    notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
    details.matchLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${PI_GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return { content: [{ type: "text", text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

/**
 * Wrap pi's grep tool so a virtual search path is answered by `grepVirtual`.
 * `gate` is agent-factory's grep allow-list check.
 */
export function withCodeViewGrep(
  tool: ToolDefinition,
  view: CodeView,
  cwd: string,
  gate: (absolutePath: string) => void,
): ToolDefinition {
  const originalExecute = tool.execute.bind(tool) as ToolDefinition["execute"];
  return {
    ...tool,
    execute: async (...executeArgs: Parameters<ToolDefinition["execute"]>) => {
      const [, params, signal, , ctx] = executeArgs;
      const p = params as GrepParams;
      const searchPath = resolveToolPath(p.path || ".", (ctx as { cwd?: string } | undefined)?.cwd || cwd);
      const loc = view.classify(searchPath);
      if (!loc) return originalExecute(...executeArgs);
      gate(searchPath);
      return grepVirtual(view, loc, searchPath, p, signal) as ReturnType<ToolDefinition["execute"]>;
    },
  };
}

