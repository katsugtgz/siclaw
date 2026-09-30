/**
 * The code-view manifest: `agents/<agentId>/.gitrepos.json` on the code volume.
 *
 * Written by the external code supplier, read by TWO processes that must agree
 * on it exactly:
 *
 *   - the Runtime's K8s spawner, which turns each entry into one read-only
 *     subPath mount of a bare mirror (`/app/.siclaw/gitrepos/<name>.git`);
 *   - the AgentBox, which only serves `<repo>@<sha>` virtual paths for a
 *     repository that is BOTH in the manifest and actually mounted.
 *
 * That is why the schema lives here, in a dependency-free module both sides
 * import, rather than in the spawner (the box must not import gateway code) or
 * in the tools (a second hand-written copy is exactly how two readers drift).
 * See docs/design/agentbox-code-volume.md ("Git layer").
 *
 * 🔴 This is EXTERNAL input. Every field is validated here, at the boundary,
 * and nothing downstream re-checks it. Two failure grains, deliberately:
 *
 *   - the document itself is unusable (not JSON, unknown version, `repos` not an
 *     array, malformed `rules`) → `CodeViewManifestError`. Callers mount / serve
 *     NOTHING from it: rules apply to every repository, so a manifest whose
 *     rules cannot be read cannot be half-trusted;
 *   - one entry is malformed or collides with another → that entry lands in
 *     `rejected` and the rest are kept. One bad row must not take away every
 *     other repository the agent is bound to.
 */

/** Same shape the supplier enforces for directory names and path segments. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * A repository name is one path segment: it becomes the mount directory
 * `<name>.git` AND the first half of a virtual path `<name>@<sha>`. Same charset
 * and 63-char cap as the agent directory names on the volume (the Runtime's
 * subPath rule), so one name is valid in every place it is spelled.
 */
export const CODE_VIEW_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,63}$/;

export const CODE_VIEW_MANIFEST_FILE = ".gitrepos.json";

/** Every bare mirror lives in the supplier's pool, never elsewhere on the volume. */
const BARE_PREFIX = "mirrors";

export interface CodeViewManifestRepo {
  /** Repository name — `<name>` in `<name>@<sha>` and in `gitrepos/<name>.git`. */
  name: string;
  host: string;
  path: string;
  /** Bare mirror path relative to the VOLUME root, e.g. `mirrors/<host>/<path>.git`. */
  bare: string;
}

export interface CodeViewRules {
  /**
   * Directory names hidden at ANY depth. A path is excluded when any of its
   * segments equals one of these — the writer's own `is_excluded` rule,
   * serialised rather than re-typed here so the two cannot drift.
   */
  excludeDirs: string[];
  /** Blobs larger than this are refused by `read` (a hygiene limit, not an authorisation boundary). */
  maxFileBytes: number;
}

export interface CodeViewManifest {
  version: 1;
  repos: CodeViewManifestRepo[];
  rules: CodeViewRules;
  /** Entries dropped at the boundary, with why — callers log these. */
  rejected: Array<{ index: number; name?: string; reason: string }>;
}

export class CodeViewManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeViewManifestError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSafeSegment(s: string): boolean {
  return SEGMENT_RE.test(s) && s !== "." && s !== ".." && !s.startsWith("-");
}

/**
 * Structural check of a `bare` path: `mirrors/<host>/<…>/<repo>.git`, every
 * segment a safe segment. Pure string work — the spawner additionally resolves
 * it on disk (realpath inside `mirrors/`, `HEAD` present), which only it can do.
 * Returns the reason it is invalid, or null.
 */
export function bareShapeProblem(bare: string): string | null {
  const segs = bare.split("/");
  if (segs.length < 3) return `bare "${bare}" must be ${BARE_PREFIX}/<host>/<path>.git`;
  if (segs[0] !== BARE_PREFIX) return `bare "${bare}" is not under ${BARE_PREFIX}/`;
  const bad = segs.find((s) => !isSafeSegment(s));
  if (bad !== undefined) return `bare "${bare}" has an invalid path segment ${JSON.stringify(bad)}`;
  if (!bare.endsWith(".git") || segs[segs.length - 1] === ".git") return `bare "${bare}" does not end in <name>.git`;
  return null;
}

function parseRules(raw: unknown): CodeViewRules {
  if (!isPlainObject(raw)) throw new CodeViewManifestError("`rules` must be an object");
  const dirs = raw.exclude_dirs;
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === "string" && isSafeSegment(d))) {
    throw new CodeViewManifestError("`rules.exclude_dirs` must be an array of directory names");
  }
  const max = raw.max_file_bytes;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) {
    throw new CodeViewManifestError("`rules.max_file_bytes` must be a positive integer");
  }
  return { excludeDirs: [...dirs] as string[], maxFileBytes: max };
}

/**
 * Parse and validate the manifest text. Throws `CodeViewManifestError` when the
 * document as a whole is unusable; per-entry problems go to `rejected`.
 */
export function parseCodeViewManifest(text: string): CodeViewManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CodeViewManifestError(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(raw)) throw new CodeViewManifestError("top level must be an object");
  // An unknown version is refused, not read best-effort: a newer supplier may
  // have changed what a field MEANS, and guessing would mount the wrong thing.
  if (raw.version !== 1) throw new CodeViewManifestError(`unsupported version ${JSON.stringify(raw.version)} (expected 1)`);
  if (!Array.isArray(raw.repos)) throw new CodeViewManifestError("`repos` must be an array");
  const rules = parseRules(raw.rules);

  const rejected: CodeViewManifest["rejected"] = [];
  const candidates: Array<{ index: number; repo: CodeViewManifestRepo }> = [];
  raw.repos.forEach((entry: unknown, index: number) => {
    if (!isPlainObject(entry)) {
      rejected.push({ index, reason: "entry is not an object" });
      return;
    }
    const { name, host, path, bare } = entry;
    const label = typeof name === "string" ? name : undefined;
    if (typeof name !== "string" || !CODE_VIEW_REPO_NAME_RE.test(name) || name === "." || name === "..") {
      rejected.push({ index, name: label, reason: `invalid name ${JSON.stringify(name)}` });
      return;
    }
    if (typeof host !== "string" || !host || typeof path !== "string" || !path) {
      rejected.push({ index, name: label, reason: "host and path must be non-empty strings" });
      return;
    }
    if (typeof bare !== "string") {
      rejected.push({ index, name: label, reason: "bare must be a string" });
      return;
    }
    const problem = bareShapeProblem(bare);
    if (problem) {
      rejected.push({ index, name: label, reason: problem });
      return;
    }
    candidates.push({ index, repo: { name, host, path, bare } });
  });

  // 🔴 A collision drops EVERY party to it, never "the first one wins". Two
  // entries with one name produce two mounts at one mountPath, which the API
  // server rejects — the whole pod, not just the repository. Two names for one
  // bare make authorization depend on list order. Picking a survivor is a guess.
  const byName = new Map<string, number>();
  const byBare = new Map<string, number>();
  for (const { repo } of candidates) {
    byName.set(repo.name, (byName.get(repo.name) ?? 0) + 1);
    byBare.set(repo.bare, (byBare.get(repo.bare) ?? 0) + 1);
  }
  const repos: CodeViewManifestRepo[] = [];
  for (const { index, repo } of candidates) {
    if ((byName.get(repo.name) ?? 0) > 1) {
      rejected.push({ index, name: repo.name, reason: `duplicate name "${repo.name}"` });
    } else if ((byBare.get(repo.bare) ?? 0) > 1) {
      rejected.push({ index, name: repo.name, reason: `bare "${repo.bare}" is listed more than once` });
    } else {
      repos.push(repo);
    }
  }
  rejected.sort((a, b) => a.index - b.index);
  return { version: 1, repos, rules, rejected };
}

/** True when any segment of a repository-relative path is an excluded directory name. */
export function isExcludedPath(relPath: string, rules: CodeViewRules): boolean {
  if (!relPath) return false;
  return relPath.split("/").some((seg) => rules.excludeDirs.includes(seg));
}
