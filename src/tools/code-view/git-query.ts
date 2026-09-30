/**
 * `git_query`: read-only history questions against the mounted bare mirrors —
 * the other half of the code-view layer. The file tools read ONE commit's tree
 * at `<reposDir>/<repo>@<sha>/…`, and those paths accept a SHA only; this tool is
 * how a branch, tag or merge request becomes a SHA, and how the agent reads
 * log / diff / show / blame. See docs/design/agentbox-code-volume.md
 * ("Git layer" → "git_query").
 *
 * Nothing the agent sends reaches git unexamined:
 *
 *   - every ref is validated here (a SHA or a conservative refname, optionally
 *     with `~N` / `^N`) and then RESOLVED to a full commit SHA with `rev-parse`
 *     before the real command runs. The command therefore only ever sees
 *     40-hex object names, which cannot be mistaken for an option — and the
 *     `--end-of-options` in front of them is a second, independent guard;
 *   - every path is repository-relative, has no `.`/`..` segments, and is passed
 *     as `:(literal)<path>` after `--`, so pathspec magic in a file name is
 *     inert;
 *   - diff drivers and textconv filters are programs named by repository
 *     attributes/config, so every command that can diff runs with
 *     `--no-ext-diff --no-textconv`; `--no-show-signature` keeps a repository's
 *     `log.showSignature` from running gpg; `--no-color` and explicit formats
 *     keep the supplier's config from reshaping the output.
 *
 * The rest — argv only, allow-listed environment, fixed `-c` prefix, timeout,
 * concurrency gate — is `runGit`'s, shared with the file tools.
 */
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolEntry } from "../../core/tool-registry.js";
import { isExcludedPath } from "../../shared/code-view-manifest.js";
import { GitCommandError, GitGateBusyError, GitTimeoutError, runGit } from "./git.js";
import {
  CodeViewError,
  excludePathspecs,
  gitFailed,
  isMissingRevision,
  unreachableCommitMessage,
  type CodeView,
  type CodeViewRepo,
  type VirtualLocation,
} from "./view.js";
import type { CodeViewRules } from "../../shared/code-view-manifest.js";

/**
 * Ceiling of one git_query result. This is NOT what the model reads directly:
 * the factory's tool-result artifact capture stores any output over 4 KiB as an
 * artifact and shows a preview, and the model pages the rest with
 * tool_result_read. Past this ceiling the output is cut at a line boundary and marked.
 */
export const GIT_QUERY_MAX_OUTPUT_BYTES = 256 * 1024;

/** `limit` ceiling for `log` and `refs`: past a couple of hundred rows the question needs a narrower filter, not more rows. */
export const GIT_QUERY_MAX_LIMIT = 200;
const LOG_DEFAULT_LIMIT = 20;
const REFS_DEFAULT_LIMIT = 100;

/** The three ref namespaces the supplier's mirror carries (heads, tags, MR heads fetched as `refs/mr/<iid>`). */
const REF_NAMESPACES = ["refs/heads", "refs/tags", "refs/mr"] as const;
/** A ref prefix safe to hand to for-each-ref as a pattern: plain ref-name characters only, no globs. */
const REF_PREFIX_RE = /^refs\/(heads|tags|mr)(\/[A-Za-z0-9._\/-]*)?$/;

export type GitQueryOp = "refs" | "log" | "diff" | "show" | "blame";
const OPS: readonly GitQueryOp[] = ["refs", "log", "diff", "show", "blame"];

export interface GitQueryParams {
  op: GitQueryOp;
  repo: string;
  ref?: string;
  from?: string;
  to?: string;
  path?: string;
  pattern?: string;
  limit?: number;
  start_line?: number;
  end_line?: number;
  stat?: boolean;
  search?: string;
  grep?: string;
}

/** The agent's arguments were refused before any git process ran. */
class GitQueryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitQueryInputError";
  }
}

const HEX_RE = /^[0-9a-f]{7,40}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
/** One refname component. Deliberately narrower than git's own rule: no leading `.`/`-`, no `{`, `:`, `\`, spaces or globs. */
const REF_COMPONENT_RE = /^[A-Za-z0-9_+@][A-Za-z0-9._+@-]*$/;
/** Trailing ancestry navigation: `~`, `~3`, `^`, `^2`, in any combination. */
const ANCESTRY_SUFFIX_RE = /(?:[~^][0-9]{0,4})*$/;
const MAX_REF_LENGTH = 255;

/**
 * Why `ref` is not acceptable, or null. Accepts a 7–40 hex SHA, `HEAD`, or a
 * refname built from safe components (`main`, `refs/heads/main`, `v1.2`,
 * `refs/mr/42`), each optionally followed by `~N` / `^N`.
 */
export function refProblem(ref: string): string | null {
  if (!ref) return "must not be empty";
  if (ref.length > MAX_REF_LENGTH) return `is longer than ${MAX_REF_LENGTH} characters`;
  const suffix = ANCESTRY_SUFFIX_RE.exec(ref)?.[0] ?? "";
  const base = ref.slice(0, ref.length - suffix.length);
  if (!base) return "has no commit or ref name before ~ / ^";
  if (HEX_RE.test(base) || base === "HEAD") return null;
  for (const component of base.split("/")) {
    if (!REF_COMPONENT_RE.test(component) || component.includes("..") || component.endsWith(".") || component.endsWith(".lock")) {
      return "is neither a commit SHA (7-40 hex) nor a ref name such as main, refs/heads/main, v1.2 or refs/mr/42";
    }
  }
  return null;
}

/**
 * Normalise a repository-relative path, or explain why it is refused. Returns
 * "" for the repository root (an empty / "." / "/"-only input is not a path
 * restriction at all, so callers treat it as absent).
 */
export function normaliseRepoPath(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") return "";
  if (trimmed.startsWith("/")) throw new GitQueryInputError(`path "${raw}" must be relative to the repository root (e.g. "src/main.ts"), not absolute`);
  if (/[\u0000-\u001f]/.test(trimmed)) throw new GitQueryInputError(`path "${JSON.stringify(raw)}" contains control characters`);
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new GitQueryInputError(`path "${raw}" must not contain empty, "." or ".." segments`);
  }
  return segments.join("/");
}

function requireRef(field: "ref" | "from" | "to", value: string | undefined): string {
  if (value === undefined || value.trim() === "") throw new GitQueryInputError(`"${field}" is required for this op`);
  const ref = value.trim();
  const problem = refProblem(ref);
  if (problem) throw new GitQueryInputError(`"${field}" ${JSON.stringify(ref)} ${problem}`);
  return ref;
}

function limitOf(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > GIT_QUERY_MAX_LIMIT) {
    throw new GitQueryInputError(`"limit" must be an integer from 1 to ${GIT_QUERY_MAX_LIMIT}, got ${value}`);
  }
  return value;
}

function lineOf(field: "start_line" | "end_line", value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new GitQueryInputError(`"${field}" must be a positive integer (1-based), got ${value}`);
  return value;
}

function assertPathAllowed(rel: string, rules: CodeViewRules): void {
  // The same rule the file tools apply: an excluded directory is invisible to
  // ls/find/grep and refused by read, so history must not become the way in.
  if (rel && isExcludedPath(rel, rules)) {
    throw new CodeViewError(
      "excluded",
      `"${rel}" is excluded from code views (directories named ${rules.excludeDirs.join(", ")} are not served).`,
    );
  }
}

interface Resolved {
  ref: string;
  sha: string;
}

/**
 * `ref` → full commit SHA. Resolving first means (a) a missing ref is reported
 * as such, with the next step, instead of as a git usage error, and (b) the
 * answer names the immutable SHA a moving branch pointed at when it was read.
 */
async function resolveCommit(repo: CodeViewRepo, ref: string, signal?: AbortSignal): Promise<Resolved> {
  try {
    const { stdout } = await runGit(repo.gitDir, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { signal });
    return { ref, sha: stdout.toString("utf8").trim() };
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;
    if (/ambiguous/i.test(err.stderr)) {
      throw new CodeViewError("ambiguous_ref", `"${ref}" matches more than one object in "${repo.name}"; use a longer SHA.`);
    }
    // A repository git refuses to open is not an unknown ref; see isMissingRevision.
    if (!isMissingRevision(err.stderr)) throw gitFailed(repo.name, err);
    const bare = ref.replace(ANCESTRY_SUFFIX_RE, "");
    throw new CodeViewError(
      "ref_unreachable",
      HEX_RE.test(bare)
        ? unreachableCommitMessage(ref, repo.name)
        : `"${ref}" does not name a commit in "${repo.name}". List branches, tags and merge requests with op "refs".`,
    );
  }
}

/** A `:(literal)` pathspec: a file literally named `:(glob)*` must stay a file name. */
function literalPathspec(rel: string): string[] {
  return rel ? [`:(literal)${rel}`] : [];
}

interface Rendered {
  text: string;
  truncated: boolean;
}

async function runCapped(repo: CodeViewRepo, args: string[], signal: AbortSignal | undefined, empty: string): Promise<Rendered> {
  const { stdout, truncated } = await runGit(repo.gitDir, args, { signal, maxOutputBytes: GIT_QUERY_MAX_OUTPUT_BYTES });
  let text = stdout.toString("utf8");
  if (truncated) {
    // Cut at the last complete line: a half line (or half a UTF-8 character)
    // would read as content that is not in the repository.
    const lastNewline = text.lastIndexOf("\n");
    text = (lastNewline > 0 ? text.slice(0, lastNewline) : text) +
      `\n\n[Output truncated at ${GIT_QUERY_MAX_OUTPUT_BYTES / 1024} KiB. Narrow it with path, limit, a line range or stat.]`;
  }
  return { text: text.trimEnd() || empty, truncated };
}

function resolvedHeader(resolved: Resolved[]): string {
  const moved = resolved.filter((r) => !FULL_SHA_RE.test(r.ref));
  return moved.length > 0 ? moved.map((r) => `${r.ref} = ${r.sha}`).join("\n") + "\n\n" : "";
}

async function opRefs(repo: CodeViewRepo, p: GitQueryParams, signal?: AbortSignal): Promise<Rendered> {
  const limit = limitOf(p.limit, REFS_DEFAULT_LIMIT);
  const pattern = p.pattern?.trim() ?? "";
  // A pattern that starts with a ref namespace is narrowed in git, so a repository
  // with tens of thousands of MR heads stays listable. 🔴 for-each-ref matches whole
  // path COMPONENTS, not string prefixes: "refs/heads/feat" would match
  // refs/heads/feat/x but not refs/heads/feature. So only the part up to the last "/"
  // is pushed down; the substring filter below still applies the full pattern.
  // It starts with "refs/", so it can never be read as an option.
  const dir = pattern.slice(0, pattern.lastIndexOf("/"));
  const namespaces = pattern.startsWith("refs/") && REF_PREFIX_RE.test(dir) ? [dir] : [...REF_NAMESPACES];
  const { stdout, truncated } = await runGit(repo.gitDir, [
    "for-each-ref", "--sort=-creatordate", "--format=%(objectname)%09%(*objectname)%09%(refname)", ...namespaces,
  ], { signal, maxOutputBytes: GIT_QUERY_MAX_OUTPUT_BYTES * 16 });
  if (truncated) {
    // Filtering needs the whole listing; a prefix of it would silently lose refs.
    throw new CodeViewError(
      "too_large",
      `The ref listing of "${repo.name}" is larger than ${(GIT_QUERY_MAX_OUTPUT_BYTES * 16) / 1024 / 1024} MiB. ` +
      `Narrow it with a pattern that starts with a ref prefix, e.g. "refs/heads/" or "refs/mr/12".`,
    );
  }
  const rows: string[] = [];
  for (const line of stdout.toString("utf8").split("\n")) {
    if (!line) continue;
    const [object, peeled, refname] = line.split("\t");
    if (pattern && !refname.includes(pattern)) continue;
    // An annotated tag's own object is not a commit; `*objectname` is the commit it tags.
    rows.push(`${peeled || object}\t${refname}`);
  }
  if (rows.length === 0) {
    return { text: pattern ? `(no ref of "${repo.name}" contains "${pattern}")` : `("${repo.name}" has no branches, tags or merge requests)`, truncated: false };
  }
  const shown = rows.slice(0, limit);
  const rest = rows.length - shown.length;
  return {
    text: shown.join("\n") + (rest > 0 ? `\n\n[${rest} more ${rest === 1 ? "ref" : "refs"} not shown. Narrow with pattern.]` : ""),
    truncated: false,
  };
}

async function opLog(repo: CodeViewRepo, rules: CodeViewRules, p: GitQueryParams, signal?: AbortSignal): Promise<Rendered> {
  const rel = normaliseRepoPath(p.path ?? "");
  assertPathAllowed(rel, rules);
  const search = p.search?.length ? p.search : undefined;
  const grep = p.grep?.length ? p.grep : undefined;
  // -S and --grep inspect every commit's diff / message: over a whole history
  // with no path and an implicit limit that is the one query here whose cost
  // the agent cannot see. Making it name its scope costs one argument.
  if ((search !== undefined || grep !== undefined) && !rel && p.limit === undefined) {
    throw new GitQueryInputError(`"search" and "grep" scan the history; give them a "path" or an explicit "limit"`);
  }
  const limit = limitOf(p.limit, LOG_DEFAULT_LIMIT);
  const resolved = await resolveCommit(repo, requireRef("ref", p.ref ?? "HEAD"), signal);
  const args = [
    "log", "--no-color", "--no-show-signature", "--no-ext-diff", "--no-textconv",
    "--date=iso-strict", "--format=%H %ad %an%x09%s", `--max-count=${limit}`,
    // Glued forms: the value can never be read as a separate option.
    ...(search !== undefined ? [`-S${search}`] : []),
    ...(grep !== undefined ? [`--grep=${grep}`] : []),
    "--end-of-options", resolved.sha, "--", ...literalPathspec(rel),
  ];
  const out = await runCapped(repo, args, signal, "(no commits match)");
  return { text: resolvedHeader([resolved]) + out.text, truncated: out.truncated };
}

async function opDiff(repo: CodeViewRepo, rules: CodeViewRules, p: GitQueryParams, signal?: AbortSignal): Promise<Rendered> {
  const rel = normaliseRepoPath(p.path ?? "");
  assertPathAllowed(rel, rules);
  const from = await resolveCommit(repo, requireRef("from", p.from), signal);
  const to = await resolveCommit(repo, requireRef("to", p.to), signal);
  const args = [
    "diff", "--no-color", "--no-ext-diff", "--no-textconv", ...(p.stat ? ["--stat"] : []),
    "--end-of-options", from.sha, to.sha, "--", ...literalPathspec(rel), ...excludePathspecs(rules),
  ];
  const out = await runCapped(repo, args, signal, "(no differences)");
  return { text: resolvedHeader([from, to]) + out.text, truncated: out.truncated };
}

async function opShow(repo: CodeViewRepo, rules: CodeViewRules, p: GitQueryParams, signal?: AbortSignal): Promise<Rendered> {
  const resolved = await resolveCommit(repo, requireRef("ref", p.ref), signal);
  const args = [
    "show", "--no-color", "--no-show-signature", "--no-ext-diff", "--no-textconv", "--format=fuller", "--stat",
    "--end-of-options", resolved.sha, "--", ...excludePathspecs(rules),
  ];
  const out = await runCapped(repo, args, signal, "(empty)");
  return { text: resolvedHeader([resolved]) + out.text, truncated: out.truncated };
}

async function opBlame(view: CodeView, repo: CodeViewRepo, rules: CodeViewRules, p: GitQueryParams, signal?: AbortSignal): Promise<Rendered> {
  const rel = normaliseRepoPath(p.path ?? "");
  if (!rel) throw new GitQueryInputError(`"path" (a file, relative to the repository root) is required for blame`);
  const start = lineOf("start_line", p.start_line);
  const end = lineOf("end_line", p.end_line);
  if (start !== undefined && end !== undefined && end < start) {
    throw new GitQueryInputError(`"end_line" (${end}) is before "start_line" (${start})`);
  }
  const resolved = await resolveCommit(repo, requireRef("ref", p.ref), signal);
  // Blame is a read of the file at that commit, so it gets `read`'s refusals
  // verbatim: excluded, missing, a directory, a symlink, a submodule, over the size cap.
  const loc: VirtualLocation = {
    repo, rules, sha: resolved.sha, root: path.join(view.reposDir, `${repo.name}@${resolved.sha}`), rel,
  };
  await view.fileEntry(loc, signal);
  const range = start !== undefined || end !== undefined ? ["-L", `${start ?? 1},${end ?? ""}`] : [];
  // No `--end-of-options`: git 2.39's blame rejects it. The revision is a
  // resolved 40-hex SHA, which cannot be parsed as an option.
  const args = ["blame", "--no-textconv", "--date=short", ...range, resolved.sha, "--", rel];
  const out = await runCapped(repo, args, signal, "(empty file)");
  return { text: resolvedHeader([resolved]) + out.text, truncated: out.truncated };
}

interface GitQueryResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** A failure the model can act on: `details.error` drives the trace outcome (docs/design/tools.md §2). */
function failure(message: string, reason: string, p: Partial<GitQueryParams>): GitQueryResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, reason }, null, 2) }],
    details: { error: true, reason, op: p.op, repo: p.repo },
  };
}

function success(text: string, p: GitQueryParams, truncated: boolean): GitQueryResult {
  return { content: [{ type: "text", text }], details: { op: p.op, repo: p.repo, truncated } };
}

const DESCRIPTION = `Read the git history of this session's code repositories: branches, tags and merge requests, commit logs, diffs, single commits and blame. Read-only, against a local mirror — no network. The repositories it can read are listed in the "Git history" section of the knowledge overview.

The file tools read any commit's files at \`<repos dir>/<repo>@<sha>/<path>\` (path shown in that section). Those paths take a SHA only — never a branch name — and this tool is how you get the SHA.

Ops:
- "refs": branches (refs/heads/…), tags (refs/tags/…) and merge-request heads (refs/mr/<iid>) with the commit each points to, most recent first. "pattern" keeps refs whose name contains it. "limit" default ${REFS_DEFAULT_LIMIT}, max ${GIT_QUERY_MAX_LIMIT}.
- "log": commits reachable from "ref" (default HEAD, the default branch), newest first — SHA, author date, author, subject. "path" keeps commits touching it; "limit" default ${LOG_DEFAULT_LIMIT}, max ${GIT_QUERY_MAX_LIMIT}. "search": commits that add or remove that exact string (git log -S). "grep": commits whose message matches that regular expression. search and grep each require "path" or an explicit "limit".
- "diff": changes from "from" to "to" (both required). "path" narrows it; "stat": true gives a per-file summary instead of the patch.
- "show": one commit ("ref") — message, author, dates and per-file change summary.
- "blame": the commit that last changed each line of the file "path" at "ref"; "start_line"/"end_line" (1-based, inclusive) narrow the range.

"ref", "from" and "to" take a commit SHA (7-40 hex), a ref name (main, refs/heads/main, v1.2, refs/mr/42), or either followed by ~N / ^N (e.g. <sha>^ is its parent). Branches move: when the output resolves a name, it prints "name = <sha>" — cite that SHA. "path" is relative to the repository root. Directories excluded from code views (such as node_modules) are left out of diff and show, and refused as "path". Output over ${GIT_QUERY_MAX_OUTPUT_BYTES / 1024} KiB is cut at a line boundary and marked.`;

export function createGitQueryTool(view: CodeView): ToolDefinition {
  return {
    name: "git_query",
    label: "Git Query",
    description: DESCRIPTION,
    parameters: Type.Object({
      op: Type.Union(OPS.map((op) => Type.Literal(op)), { description: "refs | log | diff | show | blame" }),
      repo: Type.String({ description: "Repository name, as listed in the knowledge overview's Git history section" }),
      ref: Type.Optional(Type.String({ description: "log / show / blame: commit SHA or ref name (log defaults to HEAD)" })),
      from: Type.Optional(Type.String({ description: "diff: the old side (SHA or ref name)" })),
      to: Type.Optional(Type.String({ description: "diff: the new side (SHA or ref name)" })),
      path: Type.Optional(Type.String({ description: "log / diff: restrict to this path; blame: the file. Relative to the repository root" })),
      pattern: Type.Optional(Type.String({ description: "refs: keep refs whose name contains this text" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: GIT_QUERY_MAX_LIMIT, description: `refs / log: maximum rows (max ${GIT_QUERY_MAX_LIMIT})` })),
      start_line: Type.Optional(Type.Integer({ minimum: 1, description: "blame: first line (1-based)" })),
      end_line: Type.Optional(Type.Integer({ minimum: 1, description: "blame: last line (inclusive)" })),
      stat: Type.Optional(Type.Boolean({ description: "diff: per-file summary instead of the patch" })),
      search: Type.Optional(Type.String({ description: "log: commits that add or remove this exact string (needs path or limit)" })),
      grep: Type.Optional(Type.String({ description: "log: commits whose message matches this regular expression (needs path or limit)" })),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const p = rawParams as GitQueryParams;
      try {
        if (!OPS.includes(p.op)) throw new GitQueryInputError(`"op" must be one of ${OPS.join(", ")}, got ${JSON.stringify(p.op)}`);
        if (typeof p.repo !== "string" || !p.repo.trim()) throw new GitQueryInputError(`"repo" is required`);
        const { repo, rules } = view.requireRepository(p.repo.trim());
        let out: Rendered;
        switch (p.op) {
          case "refs": out = await opRefs(repo, p, signal); break;
          case "log": out = await opLog(repo, rules, p, signal); break;
          case "diff": out = await opDiff(repo, rules, p, signal); break;
          case "show": out = await opShow(repo, rules, p, signal); break;
          case "blame": out = await opBlame(view, repo, rules, p, signal); break;
        }
        return success(out.text, p, out.truncated);
      } catch (err) {
        // Only the failures this tool can explain become a result the model
        // reads; anything else (an abort, a spawn failure, a bug) propagates.
        if (err instanceof GitQueryInputError) return failure(err.message, "invalid_argument", p);
        if (err instanceof CodeViewError) return failure(err.message, err.kind, p);
        if (err instanceof GitTimeoutError) {
          return failure(`${err.message}. Narrow the query (path, limit, a line range).`, "timeout", p);
        }
        // Stuck processes, not a slow query: narrowing would not help, so do not suggest it.
        if (err instanceof GitGateBusyError) return failure(err.message, "git_unavailable", p);
        if (err instanceof GitCommandError) return failure(err.message, "git_failed", p);
        throw err;
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createGitQueryTool(refs.codeView!),
  // Offered only when some repository's history is actually readable — the
  // manifest ∩ mounts, evaluated once per session build. An I/O fault reading
  // the manifest or the mount point is not a "no repositories" answer and
  // propagates (see the "Git layer" section of agentbox-code-volume.md).
  available: (refs) => refs.codeView !== undefined && refs.codeView.readableRepositories().length > 0,
};
