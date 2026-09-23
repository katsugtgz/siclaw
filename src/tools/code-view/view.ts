/**
 * Virtual code views: `<reposDir>/<repo>@<sha>/<path>` answered from a bare
 * mirror instead of the disk. See docs/design/agentbox-code-volume.md
 * ("Git layer").
 *
 * The four file tools (read / ls / find / grep) consult `classify()` for every
 * path. It answers `null` — "not mine, use the filesystem" — for everything
 * except a path whose first segment under `reposDir`:
 *
 *   1. does NOT exist on disk (a physical `<repo>@<view>` tree always wins), and
 *   2. splits at its LAST `@` into a repository name and 7–40 lowercase hex.
 *
 * 🔴 Only SHAs, never branch or tag names. A physical view is `<repo>@<env>`;
 * accepting symbolic refs here would put two meanings on one spelling, and a
 * branch moves, so a conclusion drawn from `app@main` could not be reproduced an
 * hour later. Symbolic refs are turned into SHAs by `git_query refs`.
 *
 * A path that passes 1 and 2 is either served or REFUSED with a reason — it is
 * never handed back to the filesystem, where it would come out as a bare "not
 * found" that hides why.
 *
 * The authoritative set of readable repositories is the manifest ∩ the mounts
 * that actually exist. The two change on different clocks: the supplier
 * rewrites the manifest while the box runs, mounts are fixed at pod creation.
 * Each disagreement has its own error, because each has a different fix.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CODE_VIEW_MANIFEST_FILE,
  CODE_VIEW_REPO_NAME_RE,
  CodeViewManifestError,
  isExcludedPath,
  parseCodeViewManifest,
  type CodeViewRules,
} from "../../shared/code-view-manifest.js";
import { GitCommandError, runGit } from "./git.js";

/** `<name>@<sha>`: the name half is validated separately against the repo-name rule. */
// Either case: a SHA copied from a UI or a log may be upper-case, and refusing it
// would fall through to the physical layer and surface as a reasonless "not found".
const VIRTUAL_SEGMENT_RE = /^(.+)@([0-9a-fA-F]{7,40})$/;

/**
 * How long one reading of manifest + mounts is trusted. Revocation must take
 * effect without a restart, but `ls` stats every entry of a directory and each
 * stat classifies a path — re-reading an NFS file hundreds of times per call
 * buys nothing a two-second window does not.
 */
export const AUTHORITY_TTL_MS = 2_000;

/** Tree listings cached per box. Trees are content-addressed, so entries never go stale. */
const TREE_CACHE_LIMIT = 512;
/** Recursive listings (find) are large; keep only a few. */
const RECURSIVE_CACHE_LIMIT = 4;

export type CodeViewErrorKind =
  | "unknown_repository"
  | "not_mounted"
  | "mount_broken"
  | "revoked"
  | "manifest_invalid"
  | "ref_unreachable"
  | "ambiguous_ref"
  | "path_not_found"
  | "excluded"
  | "too_large"
  | "not_a_file"
  | "not_a_directory"
  | "git_failed";

/**
 * A refusal from the code-view layer. The message is written for the model: it
 * names what was wrong AND the next step, because the tools surface it verbatim
 * as the tool's error.
 */
export class CodeViewError extends Error {
  constructor(readonly kind: CodeViewErrorKind, message: string) {
    super(message);
    this.name = "CodeViewError";
  }
}

export interface CodeViewRepo {
  name: string;
  /** Absolute path of the mounted bare repository. */
  gitDir: string;
}

export interface CodeViewAuthority {
  /** Readable repositories: in the manifest AND mounted. */
  repos: Map<string, CodeViewRepo>;
  /** The manifest's rules; null when there is no usable manifest (and so nothing is readable). */
  rules: CodeViewRules | null;
  /** In the manifest but not mounted — added after this box started. */
  pendingMount: Set<string>;
  /**
   * In the manifest and mounted, but the mount has no HEAD: the mirror was
   * reclaimed between the spawner's check and kubelet's mount, and kubelet
   * created the missing subPath as an empty directory. Not a repository.
   */
  brokenMount: Set<string>;
  /** Mounted but no longer in the manifest — access revoked. */
  revoked: Set<string>;
  /** The manifest exists but cannot be used. Nothing is readable while this is set. */
  manifestError: string | null;
}

export interface VirtualLocation {
  repo: CodeViewRepo;
  rules: CodeViewRules;
  /** The SHA exactly as spelled in the path (7–40 hex). */
  sha: string;
  /** Absolute path of the virtual root, `<reposDir>/<name>@<sha>`. */
  root: string;
  /** Repository-relative POSIX path; "" is the commit's root. */
  rel: string;
}

export interface TreeEntry {
  /** Git mode: 040000 tree, 100644/100755 file, 120000 symlink, 160000 submodule. */
  mode: string;
  type: "tree" | "blob" | "commit";
  oid: string;
  /** Blob size in bytes; null for trees and submodules. */
  size: number | null;
  name: string;
}

/** A recursive listing entry (find): `rel` is relative to the listed directory. */
export interface RecursiveEntry extends Omit<TreeEntry, "name"> {
  rel: string;
}

export type LookupResult = { kind: "root" } | { kind: "entry"; entry: TreeEntry };

export interface CodeViewOptions {
  /** Absolute `config.paths.reposDir`. */
  reposDir: string;
  /** Absolute `config.paths.gitReposDir`. */
  gitReposDir: string;
  /** Override for tests; 0 re-reads on every call. */
  authorityTtlMs?: number;
}

class LruMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly limit: number) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as K);
  }
}

// The pathspecs that hide the supplier's excluded directories from a git
// command that walks a tree (`git grep`, `git diff`, `git show --stat`). Both
// spellings are needed: `**/<d>` matches the entry itself (a submodule or
// symlink by that name), `**/<d>/**` everything below it. (A line comment: the
// glob would end a block comment.)
export function excludePathspecs(rules: CodeViewRules): string[] {
  return rules.excludeDirs.flatMap((d) => [`:(exclude,glob)**/${d}`, `:(exclude,glob)**/${d}/**`]);
}

function isInside(child: string, dir: string): boolean {
  return child.startsWith(dir + path.sep);
}

/**
 * Parse `git ls-tree -z [-l] [-r -t]` output. With `-l` the size column is
 * present (`-` for trees / submodules). Names are raw bytes decoded as UTF-8,
 * which is what the physical trees' file names are as well.
 */
export function parseLsTree(out: Buffer, withSize: boolean): Array<Omit<TreeEntry, "name"> & { name: string }> {
  const entries: Array<Omit<TreeEntry, "name"> & { name: string }> = [];
  let start = 0;
  while (start < out.length) {
    const end = out.indexOf(0, start);
    const record = out.subarray(start, end === -1 ? out.length : end).toString("utf8");
    start = end === -1 ? out.length : end + 1;
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) throw new Error(`unexpected ls-tree record: ${JSON.stringify(record)}`);
    const meta = record.slice(0, tab).split(/ +/);
    const name = record.slice(tab + 1);
    const [mode, type, oid] = meta;
    if (type !== "tree" && type !== "blob" && type !== "commit") {
      throw new Error(`unexpected ls-tree object type ${JSON.stringify(type)}`);
    }
    const sizeField = withSize ? meta[3] : undefined;
    const size = sizeField === undefined || sizeField === "-" ? null : Number(sizeField);
    entries.push({ mode, type, oid, size, name });
  }
  return entries;
}

export class CodeView {
  readonly reposDir: string;
  readonly gitReposDir: string;
  private readonly ttlMs: number;
  private authority: { at: number; value: CodeViewAuthority } | null = null;
  private lastLoggedManifestError: string | null = null;
  private readonly commits = new LruMap<string, string>(1024);
  private readonly trees = new LruMap<string, TreeEntry[]>(TREE_CACHE_LIMIT);
  private readonly recursive = new LruMap<string, RecursiveEntry[]>(RECURSIVE_CACHE_LIMIT);

  constructor(opts: CodeViewOptions) {
    this.reposDir = path.resolve(opts.reposDir);
    this.gitReposDir = path.resolve(opts.gitReposDir);
    this.ttlMs = opts.authorityTtlMs ?? AUTHORITY_TTL_MS;
  }

  // ── Authority ─────────────────────────────────────────────────────────────

  /**
   * Manifest ∩ mounts, re-read at most every `authorityTtlMs`.
   *
   * A missing manifest is the normal state of a box whose supplier has not
   * adopted the git layer: nothing readable, nothing wrong. An UNUSABLE manifest
   * is different — it is recorded as `manifestError` (and logged once per
   * distinct reason) so a request for a virtual path can say why nothing is
   * readable instead of pretending the repository is unknown.
   */
  getAuthority(): CodeViewAuthority {
    const now = Date.now();
    if (this.authority && now - this.authority.at < this.ttlMs) return this.authority.value;
    const value = this.readAuthority();
    this.authority = { at: now, value };
    return value;
  }

  private mounted(): { live: Set<string>; broken: Set<string> } {
    let names: string[];
    try {
      names = fs.readdirSync(this.gitReposDir);
    } catch (err) {
      // No mount point at all: the spawner mounted no mirrors. Anything else is
      // a real fault of the box's filesystem and must surface.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { live: new Set(), broken: new Set() };
      throw err;
    }
    const live = new Set<string>();
    const broken = new Set<string>();
    for (const entry of names) {
      if (!entry.endsWith(".git")) continue;
      const name = entry.slice(0, -".git".length);
      if (!CODE_VIEW_REPO_NAME_RE.test(name)) continue;
      // HEAD, not the directory: kubelet creates a missing subPath as an EMPTY
      // directory, and a reclaimed mirror leaves one behind. Neither is a
      // repository — but it IS a mount, and must be reported as a broken one
      // rather than as "not mounted yet".
      if (fs.existsSync(path.join(this.gitReposDir, entry, "HEAD"))) live.add(name);
      else broken.add(name);
    }
    return { live, broken };
  }

  private readAuthority(): CodeViewAuthority {
    const { live: mounted, broken } = this.mounted();
    const manifestPath = path.join(this.reposDir, CODE_VIEW_MANIFEST_FILE);
    let text: string | null;
    try {
      text = fs.readFileSync(manifestPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      text = null;
    }
    if (text === null) {
      // No manifest: every mount (if any) is unaccounted for, i.e. revoked.
      return { repos: new Map(), rules: null, pendingMount: new Set(), brokenMount: new Set(), revoked: new Set([...mounted, ...broken]), manifestError: null };
    }
    let manifest;
    try {
      manifest = parseCodeViewManifest(text);
    } catch (err) {
      if (!(err instanceof CodeViewManifestError)) throw err;
      const reason = `${manifestPath}: ${err.message}`;
      if (this.lastLoggedManifestError !== reason) {
        this.lastLoggedManifestError = reason;
        console.error(`[code-view] manifest unusable, no commit is readable: ${reason}`);
      }
      return { repos: new Map(), rules: null, pendingMount: new Set(), brokenMount: new Set(), revoked: new Set(), manifestError: err.message };
    }
    const repos = new Map<string, CodeViewRepo>();
    const pendingMount = new Set<string>();
    const brokenMount = new Set<string>();
    const listed = new Set<string>();
    for (const r of manifest.repos) {
      listed.add(r.name);
      if (mounted.has(r.name)) repos.set(r.name, { name: r.name, gitDir: path.join(this.gitReposDir, `${r.name}.git`) });
      else if (broken.has(r.name)) brokenMount.add(r.name);
      else pendingMount.add(r.name);
    }
    const revoked = new Set([...mounted, ...broken].filter((n) => !listed.has(n)));
    return { repos, rules: manifest.rules, pendingMount, brokenMount, revoked, manifestError: null };
  }

  /** Names of the repositories whose commits are readable right now. */
  readableRepositories(): string[] {
    return [...this.getAuthority().repos.keys()].sort();
  }

  /**
   * Resolve a repository name against the authoritative set, or throw the
   * specific reason it is not readable. For `git_query`, which takes a bare
   * repository name rather than a path.
   */
  requireRepository(name: string): { repo: CodeViewRepo; rules: CodeViewRules } {
    const auth = this.getAuthority();
    if (auth.manifestError !== null) {
      throw new CodeViewError(
        "manifest_invalid",
        `No commit can be read: the code-view manifest is invalid (${auth.manifestError}). ` +
        `The physical views under ${this.reposDir} are unaffected.`,
      );
    }
    const repo = auth.repos.get(name);
    if (repo && auth.rules) return { repo, rules: auth.rules };
    // Mounts are decided once, at the box's cold start, and a box is reused across
    // sessions — so "a new session" would be a false promise. Say what actually fixes it.
    if (auth.pendingMount.has(name)) {
      throw new CodeViewError(
        "not_mounted",
        `Repository "${name}" was granted after this box started; its history becomes readable after the box's next cold start.`,
      );
    }
    if (auth.brokenMount.has(name)) {
      throw new CodeViewError(
        "mount_broken",
        `The mirror mounted for repository "${name}" has no HEAD (it was reclaimed or not yet populated when this box ` +
        `started), so its commits cannot be read. This is a mount inconsistency, not a missing commit; it clears after ` +
        `the box's next cold start.`,
      );
    }
    if (auth.revoked.has(name)) {
      throw new CodeViewError("revoked", `Access to repository "${name}" has been revoked; its commits can no longer be read.`);
    }
    const readable = [...auth.repos.keys()].sort();
    throw new CodeViewError(
      "unknown_repository",
      `Unknown repository "${name}". ` +
      (readable.length > 0
        ? `Repositories whose commits can be read: ${readable.join(", ")}.`
        : "No repository's commit history is readable in this session."),
    );
  }

  // ── Path classification ───────────────────────────────────────────────────

  /**
   * `null` when `absPath` is not a virtual path (use the filesystem). Otherwise
   * the location — or a thrown `CodeViewError` when it IS virtual-shaped but not
   * readable. Paths are expected already resolved (absolute, normalised).
   */
  classify(absPath: string): VirtualLocation | null {
    const resolved = path.resolve(absPath);
    if (!isInside(resolved, this.reposDir)) return null;
    const [segment, ...rest] = path.relative(this.reposDir, resolved).split(path.sep);
    const root = path.join(this.reposDir, segment);
    // A physical tree always wins, whatever its name looks like.
    if (fs.existsSync(root)) return null;
    const m = VIRTUAL_SEGMENT_RE.exec(segment);
    if (!m || !CODE_VIEW_REPO_NAME_RE.test(m[1])) return null;
    const { repo, rules } = this.requireRepository(m[1]);
    return { repo, rules, sha: m[2].toLowerCase(), root, rel: rest.join("/") };
  }

  /** The absolute virtual path of a repository-relative path under `loc`'s commit. */
  absolute(loc: VirtualLocation, rel: string): string {
    return rel ? path.join(loc.root, ...rel.split("/")) : loc.root;
  }

  // ── Git access ────────────────────────────────────────────────────────────

  /**
   * Full SHA of the commit the path names. Short SHAs are expanded; an ambiguous
   * one is refused rather than guessed. Successes are cached (a commit is
   * immutable); misses are not — the writer keeps fetching into the mirror, so
   * an unreachable commit may be there on the next try.
   */
  async commit(loc: VirtualLocation, signal?: AbortSignal): Promise<string> {
    const key = `${loc.repo.gitDir}\0${loc.sha}`;
    const hit = this.commits.get(key);
    if (hit) return hit;
    try {
      const { stdout } = await runGit(loc.repo.gitDir, ["rev-parse", "--verify", `${loc.sha}^{commit}`], { signal });
      const full = stdout.toString("utf8").trim();
      this.commits.set(key, full);
      return full;
    } catch (err) {
      if (!(err instanceof GitCommandError)) throw err;
      if (/ambiguous/i.test(err.stderr)) {
        throw new CodeViewError(
          "ambiguous_ref",
          `"${loc.sha}" matches more than one object in "${loc.repo.name}"; use a longer SHA.`,
        );
      }
      // Only "no such object" means the commit is absent. Anything else — a repository
      // git refuses to open (ownership, corruption, permissions) — must not be dressed
      // up as a missing commit: that would send the agent to code-mcp on every read
      // and hide the real fault.
      if (!isMissingRevision(err.stderr)) throw gitFailed(loc.repo.name, err);
      throw new CodeViewError(
        "ref_unreachable",
        `Commit ${loc.sha} is not in the local mirror of "${loc.repo.name}" (it may be newer than the mirror's last ` +
        `fetch, or not on any branch, tag or merge request of this repository). Read the file at that SHA through ` +
        `code-mcp instead, or list known commits with git_query.`,
      );
    }
  }

  /** Entries of one tree object, cached by object id (shared across commits). */
  async tree(loc: VirtualLocation, treeish: string, signal?: AbortSignal): Promise<TreeEntry[]> {
    const key = `${loc.repo.gitDir}\0${treeish}`;
    const hit = this.trees.get(key);
    if (hit) return hit;
    const { stdout } = await runGit(loc.repo.gitDir, ["ls-tree", "-z", "-l", "--end-of-options", treeish], { signal });
    const entries = parseLsTree(stdout, true);
    this.trees.set(key, entries);
    return entries;
  }

  /**
   * Look up a repository-relative path in the commit, walking from the root one
   * cached tree at a time. `null` = no such path (or an excluded one — the
   * caller asks `isExcluded` first when it needs to tell those apart).
   */
  async lookup(loc: VirtualLocation, rel: string, signal?: AbortSignal): Promise<LookupResult | null> {
    let treeish = await this.commit(loc, signal);
    if (!rel) return { kind: "root" };
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      const entries = await this.tree(loc, treeish, signal);
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) return { kind: "entry", entry };
      if (entry.type !== "tree") return null;
      treeish = entry.oid;
    }
    return null;
  }

  isExcluded(loc: VirtualLocation, rel: string): boolean {
    return isExcludedPath(rel, loc.rules);
  }

  /** Throw the model-facing refusal for a path that is excluded by the supplier's rules. */
  assertNotExcluded(loc: VirtualLocation, rel: string): void {
    if (this.isExcluded(loc, rel)) {
      throw new CodeViewError(
        "excluded",
        `"${rel}" is excluded from code views (directories named ${loc.rules.excludeDirs.join(", ")} are not served).`,
      );
    }
  }

  pathNotFound(loc: VirtualLocation, rel: string): CodeViewError {
    return new CodeViewError("path_not_found", `Path "${rel}" does not exist in ${loc.repo.name}@${loc.sha}.`);
  }

  /** Directory entries (excluded names removed). Throws for a missing path or a non-directory. */
  async readDir(loc: VirtualLocation, rel: string, signal?: AbortSignal): Promise<TreeEntry[]> {
    this.assertNotExcluded(loc, rel);
    const found = await this.lookup(loc, rel, signal);
    if (!found) throw this.pathNotFound(loc, rel);
    let treeish: string;
    if (found.kind === "root") treeish = await this.commit(loc, signal);
    else if (found.entry.type === "tree") treeish = found.entry.oid;
    else if (found.entry.type === "commit") return []; // a submodule: an empty directory, as `git archive` leaves it
    else throw new CodeViewError("not_a_directory", `"${rel}" in ${loc.repo.name}@${loc.sha} is a file, not a directory.`);
    const entries = await this.tree(loc, treeish, signal);
    return entries.filter((e) => !this.isExcluded(loc, rel ? `${rel}/${e.name}` : e.name));
  }

  /**
   * Every entry below a directory (trees included, so globs can match directories
   * as they do on disk), with excluded paths removed. Cached per (commit, dir).
   */
  async listRecursive(loc: VirtualLocation, rel: string, signal?: AbortSignal): Promise<RecursiveEntry[]> {
    const commit = await this.commit(loc, signal);
    const key = `${loc.repo.gitDir}\0${commit}\0${rel}`;
    const hit = this.recursive.get(key);
    if (hit) return hit;
    const treeish = rel ? `${commit}:${rel}` : commit;
    // No -l: find matches on names and types only, and -l makes git open every
    // blob's header for its size — on a large repository over NFS, the difference
    // between a fast listing and the 20-second timeout.
    const { stdout, truncated } = await runGit(
      loc.repo.gitDir, ["ls-tree", "-r", "-t", "-z", "--end-of-options", treeish], { signal },
    );
    if (truncated) {
      throw new CodeViewError(
        "too_large",
        `Listing ${loc.repo.name}@${loc.sha}/${rel} exceeded the output cap; search a narrower path.`,
      );
    }
    const entries: RecursiveEntry[] = parseLsTree(stdout, false)
      .map(({ name, ...rest }) => ({ ...rest, rel: name }))
      .filter((e) => !this.isExcluded(loc, rel ? `${rel}/${e.rel}` : e.rel));
    this.recursive.set(key, entries);
    return entries;
  }

  /**
   * The bytes of a regular file, after every refusal a physical read would not
   * need: excluded, missing, a directory, a symlink, a submodule, over the size cap.
   */
  async readFile(loc: VirtualLocation, signal?: AbortSignal): Promise<Buffer> {
    const entry = await this.fileEntry(loc, signal);
    const { stdout, truncated } = await runGit(loc.repo.gitDir, ["cat-file", "blob", entry.oid], {
      signal,
      maxOutputBytes: loc.rules.maxFileBytes + 1,
    });
    if (truncated) throw this.tooLarge(loc, stdout.length);
    return stdout;
  }

  /** The tree entry of a readable regular file — `readFile`'s checks without the read. */
  async fileEntry(loc: VirtualLocation, signal?: AbortSignal): Promise<TreeEntry> {
    const { rel } = loc;
    if (!rel) throw new CodeViewError("not_a_file", `${loc.repo.name}@${loc.sha} is a directory; list it with ls.`);
    this.assertNotExcluded(loc, rel);
    const found = await this.lookup(loc, rel, signal);
    if (!found) throw this.pathNotFound(loc, rel);
    if (found.kind === "root") throw new CodeViewError("not_a_file", `${loc.repo.name}@${loc.sha} is a directory.`);
    const { entry } = found;
    if (entry.type === "tree") {
      throw new CodeViewError("not_a_file", `"${rel}" in ${loc.repo.name}@${loc.sha} is a directory; list it with ls.`);
    }
    if (entry.type === "commit") {
      throw new CodeViewError("not_a_file", `"${rel}" in ${loc.repo.name}@${loc.sha} is a git submodule; its content is not part of this repository.`);
    }
    if (entry.mode === "120000") {
      // A symlink blob holds the TARGET, not content. Handing it back as the
      // file would be a silent wrong answer; name the target so the next read works.
      const { stdout } = await runGit(loc.repo.gitDir, ["cat-file", "blob", entry.oid], { signal, maxOutputBytes: 4096 });
      const target = stdout.toString("utf8");
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
      throw new CodeViewError(
        "not_a_file",
        `"${rel}" in ${loc.repo.name}@${loc.sha} is a symbolic link to "${target}"` +
        (resolved.startsWith("../") || path.posix.isAbsolute(target) ? " (outside the repository)." : `; read "${resolved}" instead.`),
      );
    }
    if (entry.size !== null && entry.size > loc.rules.maxFileBytes) throw this.tooLarge(loc, entry.size);
    return entry;
  }

  private tooLarge(loc: VirtualLocation, size: number): CodeViewError {
    return new CodeViewError(
      "too_large",
      `"${loc.rel}" in ${loc.repo.name}@${loc.sha} is ${size} bytes, over the ${loc.rules.maxFileBytes}-byte limit for code views.`,
    );
  }
}

const shared = new Map<string, CodeView>();

/**
 * The box-wide `CodeView` for one (reposDir, gitReposDir) pair. Sessions, the
 * four file tools and `git_query` share it, so they share one authority reading
 * and one tree cache (trees are immutable, so sharing is always safe).
 */
export function codeViewFor(opts: { reposDir: string; gitReposDir: string }): CodeView {
  const reposDir = path.resolve(opts.reposDir);
  const gitReposDir = path.resolve(opts.gitReposDir);
  const key = `${reposDir}\0${gitReposDir}`;
  let view = shared.get(key);
  if (!view) {
    view = new CodeView({ reposDir, gitReposDir });
    shared.set(key, view);
  }
  return view;
}

/**
 * Does git's stderr say the revision does not exist (as opposed to git failing
 * for another reason)? `rev-parse --verify` prints "Needed a single revision";
 * other plumbing prints "unknown revision" / "bad revision" / "not a valid object name".
 */
export function isMissingRevision(stderr: string): boolean {
  return /Needed a single revision|unknown revision|bad revision|not a valid object name|bad object/i.test(stderr);
}

/** A git failure that is not a missing object: surface git's own words, first line only. */
export function gitFailed(repo: string, err: GitCommandError): CodeViewError {
  const detail = err.stderr.trim().split("\n")[0] || `exit code ${err.exitCode}`;
  return new CodeViewError("git_failed", `git could not read repository "${repo}": ${detail}`);
}
