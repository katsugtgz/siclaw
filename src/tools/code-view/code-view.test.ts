/**
 * The code-view layer against REAL git: a bare repository built in a temp dir,
 * mounted where the box would see it, plus the same commit written out as a
 * plain directory with the manifest's rules applied. That directory is the
 * REFERENCE: pi's own tools read it from disk, and every virtual answer must
 * equal theirs. Contract: docs/design/agentbox-code-volume.md ("Git layer").
 */
import { vi } from "vitest";
// pi resolves rg from its own agent dir BEFORE PATH, and freezes that dir at
// import time. Point it at an empty location so the contract suite runs the rg
// on PATH (what `rgAvailable` checks) and never a cached or downloaded copy.
vi.hoisted(() => {
  process.env.PI_CODING_AGENT_DIR = `${process.env.TMPDIR ?? "/tmp"}/code-view-test-no-pi-agent-dir`;
  process.env.PI_OFFLINE = "1";
});
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { globSync } from "glob";
import { CodeView, CodeViewError } from "./view.js";
import { codeViewFindOps, codeViewLsOps, codeViewReadOps } from "./file-ops.js";
import { compileRgGlob, withCodeViewGrep } from "./grep.js";

const MAX_FILE_BYTES = 4096;
const RULES = { exclude_dirs: ["node_modules", "dist"], max_file_bytes: MAX_FILE_BYTES };

/** Files of the fixture commit; NOT_EXPORTED lists the ones the rules keep out of the on-disk reference copy. */
const FILES: Record<string, string> = {
  "README.md": "# app\nthe needle is documented here\n",
  ".hidden.ts": "export const needle = 1;\n",
  "src/main.ts": [
    "import { helper } from './util/helpers';",
    "// needle: first",
    "const x = 1;",
    "const y = 2;",
    "// NEEDLE shouting",
    "export const z = needle + needle;",
    "a.b literal",
    "axb regex-only",
    "",
  ].join("\n"),
  "src/util/helpers.ts": "export function helper() {\n  return 'needle';\n}\n",
  "src/[id]/page.tsx": "export default () => 'needle in tsx';\n",
  "src/[id]/page.ts": "export const needle = 'ts';\n",
  "docs/guide.md": "needle in docs\nsecond line\n",
  "crlf.txt": "one\r\nneedle crlf\r\nthree\r\n",
  "long.txt": `needle ${"x".repeat(700)}\n`,
  "many.txt": Array.from({ length: 150 }, (_, i) => `many ${i}`).join("\n") + "\n",
  "node_modules/pkg/index.js": "module.exports = 'needle';\n",
  "web/dist/bundle.js": "needle bundled\n",
  "web/app.js": "export {};\n",
  "big.txt": `${"b".repeat(MAX_FILE_BYTES + 10)}\n`,
};
const NOT_EXPORTED = ["node_modules/pkg/index.js", "web/dist/bundle.js", "big.txt"];

let root: string;
let reposDir: string;
let gitReposDir: string;
let bare: string;
let sha: string;
let short: string;
let physical: string;
let virtual: string;
let savedCwd: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd })
    .toString().trim();
}
function writeManifest(repos: Array<{ name: string; bare?: string }>, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(reposDir, ".gitrepos.json"), JSON.stringify({
    version: 1,
    updated_at: "t",
    repos: repos.map((r) => ({ name: r.name, host: "gitlab.x", path: `grp/${r.name}`, bare: r.bare ?? `mirrors/gitlab.x/grp/${r.name}.git` })),
    rules: RULES,
    ...extra,
  }));
}

beforeAll(() => {
  savedCwd = process.cwd();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-view-")));
  reposDir = path.join(root, ".siclaw", "repos");
  gitReposDir = path.join(root, ".siclaw", "gitrepos");
  const work = path.join(root, "work");
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.join(work, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
  }
  fs.writeFileSync(path.join(work, "bin.dat"), Buffer.from("needle\0binary\n"));
  fs.symlinkSync("src/main.ts", path.join(work, "link.ts"));
  git(root, "init", "-q", work);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "fixture");
  sha = git(work, "rev-parse", "HEAD");
  short = sha.slice(0, 10);
  fs.mkdirSync(gitReposDir, { recursive: true });
  bare = path.join(gitReposDir, "app.git");
  git(root, "clone", "-q", "--bare", work, bare);
  // A second commit, so "the SHA in the path" is distinguishable from "HEAD".
  fs.writeFileSync(path.join(work, "src/main.ts"), "changed after the fixture commit\n");
  git(work, "commit", "-qam", "later");
  git(bare, "fetch", "-q", work, "+refs/heads/*:refs/heads/*");

  // The on-disk reference: `sha` as a plain directory, minus what the rules exclude.
  physical = path.join(reposDir, "app-checkout");
  for (const [rel, content] of Object.entries(FILES)) {
    if (NOT_EXPORTED.includes(rel)) continue;
    fs.mkdirSync(path.join(physical, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(physical, rel), content);
  }
  fs.writeFileSync(path.join(physical, "bin.dat"), Buffer.from("needle\0binary\n"));
  fs.symlinkSync("src/main.ts", path.join(physical, "link.ts"));
  virtual = path.join(reposDir, `app@${sha}`);
  writeManifest([{ name: "app" }]);
});
afterAll(() => {
  process.chdir(savedCwd);
  fs.rmSync(root, { recursive: true, force: true });
});

const newView = () => new CodeView({ reposDir, gitReposDir, authorityTtlMs: 0 });
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");

/** The four tools, wired the way agent-factory wires them (minus the allow-list, which is not under test). */
function tools(view = newView()) {
  const noGate = () => {};
  return {
    read: createReadTool(root, {
      operations: codeViewReadOps(view, {
        readFile: (p) => fs.promises.readFile(p),
        access: (p) => fs.promises.access(p, fs.constants.R_OK),
      }, noGate),
    }) as unknown as ToolDefinition,
    ls: createLsTool(root, {
      operations: codeViewLsOps(view, {
        exists: (p) => fs.existsSync(p),
        stat: (p) => fs.statSync(p),
        readdir: (p) => fs.readdirSync(p),
      }, noGate),
    }) as unknown as ToolDefinition,
    find: createFindTool(root, {
      operations: codeViewFindOps(view, {
        exists: (p) => fs.existsSync(p),
        glob: (pattern, cwd, o) => globSync(pattern, { cwd, absolute: true, dot: true, ignore: o.ignore }).slice(0, o.limit),
      }, noGate),
    }) as unknown as ToolDefinition,
    grep: withCodeViewGrep(createGrepTool(root, {
      operations: {
        isDirectory: (p) => fs.statSync(p).isDirectory(),
        readFile: (p) => fs.readFileSync(p, "utf-8"),
      },
    }) as unknown as ToolDefinition, view, root, noGate),
  };
}
const run = (tool: ToolDefinition, params: Record<string, unknown>) =>
  tool.execute("t", params as never, undefined, undefined, undefined as never);

// ── classification and authority ─────────────────────────────────────────────

describe("CodeView.classify", () => {
  afterEach(() => writeManifest([{ name: "app" }]));

  it("leaves every non-virtual path to the filesystem", () => {
    const view = newView();
    expect(view.classify(path.join(root, "work", "README.md"))).toBeNull();
    expect(view.classify(reposDir)).toBeNull();
    expect(view.classify(path.join(physical, "src"))).toBeNull();
    expect(view.classify(path.join(reposDir, ".gitrepos.json"))).toBeNull();
    // Not hex / too short / a branch name: not virtual-shaped at all.
    expect(view.classify(path.join(reposDir, "app@main"))).toBeNull();
    expect(view.classify(path.join(reposDir, "app@abc12"))).toBeNull();
  });

  it("an upper-case SHA (copied from a UI or a log) is the same commit, not a silent 'not found'", () => {
    const loc = newView().classify(path.join(reposDir, `app@${sha.toUpperCase()}`, "README.md"))!;
    expect(loc.sha).toBe(sha);
    expect(loc.rel).toBe("README.md");
  });

  it("a physical directory wins even when its name looks like a SHA", () => {
    const shaped = path.join(reposDir, "app@deadbeef");
    fs.mkdirSync(shaped);
    try {
      expect(newView().classify(path.join(shaped, "x"))).toBeNull();
    } finally {
      fs.rmdirSync(shaped);
    }
  });

  it("splits at the LAST @ and returns the repository-relative path", () => {
    const loc = newView().classify(path.join(virtual, "src", "util", "helpers.ts"))!;
    expect(loc.repo).toEqual({ name: "app", gitDir: bare });
    expect(loc.sha).toBe(sha);
    expect(loc.rel).toBe("src/util/helpers.ts");
    expect(loc.root).toBe(virtual);
  });

  it("an unknown repository is refused with the list of readable ones", () => {
    const err = (() => { try { newView().classify(path.join(reposDir, `other@${sha}`)); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(CodeViewError);
    expect((err as CodeViewError).kind).toBe("unknown_repository");
    expect((err as Error).message).toMatch(/Repositories whose commits can be read: app/);
  });

  it("in the manifest but not mounted → readable after the box's next cold start, not 'unknown'", () => {
    // A box is reused across sessions, so "a new session" would be a false promise.
    writeManifest([{ name: "app" }, { name: "late" }]);
    const err = (() => { try { newView().classify(path.join(reposDir, `late@${sha}`)); } catch (e) { return e; } })();
    expect((err as CodeViewError).kind).toBe("not_mounted");
    expect((err as Error).message).toMatch(/next cold start/);
    expect((err as Error).message).not.toMatch(/new session/);
  });

  it("mounted without a HEAD (reclaimed before kubelet mounted it) → a broken mount, not 'not mounted yet'", () => {
    const empty = path.join(gitReposDir, "gone.git");
    fs.mkdirSync(empty);
    try {
      writeManifest([{ name: "app" }, { name: "gone" }]);
      const err = (() => { try { newView().classify(path.join(reposDir, `gone@${sha}`)); } catch (e) { return e; } })();
      expect((err as CodeViewError).kind).toBe("mount_broken");
      expect((err as Error).message).toMatch(/mount inconsistency, not a missing commit/);
      expect(newView().readableRepositories()).toEqual(["app"]);
    } finally {
      fs.rmSync(empty, { recursive: true });
    }
  });

  it("mounted but gone from the manifest → revoked immediately, although the mount remains", () => {
    writeManifest([]);
    const err = (() => { try { newView().classify(path.join(virtual, "README.md")); } catch (e) { return e; } })();
    expect((err as CodeViewError).kind).toBe("revoked");
  });

  it("no manifest at all → every mount is unaccounted for, so refused", () => {
    fs.rmSync(path.join(reposDir, ".gitrepos.json"));
    expect(() => newView().classify(path.join(virtual, "README.md"))).toThrow(/revoked/);
    expect(newView().readableRepositories()).toEqual([]);
  });

  it("an unusable manifest refuses everything and says why", () => {
    fs.writeFileSync(path.join(reposDir, ".gitrepos.json"), "{broken");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = newView();
      expect(() => view.classify(path.join(virtual, "README.md"))).toThrow(/manifest is invalid/);
      expect(view.readableRepositories()).toEqual([]);
      view.getAuthority();
      expect(spy).toHaveBeenCalledTimes(1); // logged once per distinct reason, not per call
    } finally {
      spy.mockRestore();
    }
  });

  it("an empty mount directory (no HEAD — what kubelet leaves) is not a repository", () => {
    fs.mkdirSync(path.join(gitReposDir, "ghost.git"));
    writeManifest([{ name: "app" }, { name: "ghost" }]);
    try {
      expect(newView().readableRepositories()).toEqual(["app"]);
      expect(() => newView().classify(path.join(reposDir, `ghost@${sha}`))).toThrow(/mount inconsistency/);
    } finally {
      fs.rmdirSync(path.join(gitReposDir, "ghost.git"));
    }
  });

  it("re-reads the authority only after its TTL", () => {
    const view = new CodeView({ reposDir, gitReposDir, authorityTtlMs: 60_000 });
    expect(view.readableRepositories()).toEqual(["app"]);
    writeManifest([]);
    expect(view.readableRepositories()).toEqual(["app"]);
    expect(newView().readableRepositories()).toEqual([]);
  });
});

describe("CodeView commits", () => {
  it("expands a short SHA and caches it", async () => {
    const view = newView();
    const loc = view.classify(path.join(reposDir, `app@${short}`, "README.md"))!;
    expect(await view.commit(loc)).toBe(sha);
  });

  it("a commit the mirror does not have is 'unreachable': not fetched yet, retry, or list refs", async () => {
    const view = newView();
    const loc = view.classify(path.join(reposDir, `app@${"1".repeat(40)}`, "README.md"))!;
    const err = await view.commit(loc).catch((e) => e);
    expect(err).toMatchObject({ kind: "ref_unreachable" });
    const message = (err as Error).message;
    expect(message).toContain("may not have fetched it yet");
    expect(message).toContain("retry later");
    expect(message).toContain('git_query op "refs"');
    // The retired code MCP is not a next step any more.
    expect(message).not.toMatch(/code-mcp/i);
  });

  it("a repository git refuses to open is 'git_failed' with git's reason — never dressed up as a missing commit", async () => {
    // HEAD present (so it counts as mounted) but no object store: what a corrupt
    // mirror, or one git will not open (ownership, permissions), looks like from here.
    const broken = path.join(gitReposDir, "corrupt.git");
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, "HEAD"), "ref: refs/heads/main\n");
    try {
      writeManifest([{ name: "app" }, { name: "corrupt" }]);
      const view = newView();
      const loc = view.classify(path.join(reposDir, `corrupt@${sha}`, "README.md"))!;
      const err = await view.commit(loc).catch((e) => e);
      expect(err).toBeInstanceOf(CodeViewError);
      expect((err as CodeViewError).kind).toBe("git_failed");
      // Waiting for a fetch cannot fix a repository git refuses to open.
      expect((err as Error).message).not.toMatch(/retry later/);
    } finally {
      fs.rmSync(broken, { recursive: true });
      writeManifest([{ name: "app" }]);
    }
  });
});

// ── read / ls / find ─────────────────────────────────────────────────────────

describe("read on a virtual path", () => {
  it("reads the file AT THAT COMMIT, not the branch head", async () => {
    const r = await run(tools().read, { path: path.join(virtual, "src/main.ts") });
    expect(text(r)).toContain("// needle: first");
    expect(text(r)).not.toContain("changed after");
  });

  it("output is identical to reading the same commit from disk", async () => {
    const t = tools();
    for (const rel of ["src/main.ts", "crlf.txt", "long.txt", "many.txt"]) {
      const a = await run(t.read, { path: path.join(physical, rel), offset: 2, limit: 3 });
      const b = await run(t.read, { path: path.join(virtual, rel), offset: 2, limit: 3 });
      expect(b).toEqual(a);
    }
  });

  it.each([
    ["an excluded directory", "node_modules/pkg/index.js", /excluded from code views/],
    ["an excluded directory at depth", "web/dist/bundle.js", /excluded from code views/],
    ["a file over max_file_bytes", "big.txt", /over the 4096-byte limit/],
    ["a directory", "src", /is a directory/],
    ["a missing path", "src/nope.ts", /does not exist in app@/],
    ["a symlink (names its target instead of returning it as content)", "link.ts", /symbolic link to "src\/main.ts"; read "src\/main.ts"/],
  ])("refuses %s", async (_label, rel, message) => {
    await expect(run(tools().read, { path: path.join(virtual, rel) })).rejects.toThrow(message);
  });
});

describe("ls on a virtual path", () => {
  it("lists like the same commit on disk (sorted, / for directories, excluded names hidden)", async () => {
    const t = tools();
    for (const rel of ["", "src", "src/[id]"]) {
      const a = await run(t.ls, { path: rel ? path.join(physical, rel) : physical });
      const b = await run(t.ls, { path: rel ? path.join(virtual, rel) : virtual });
      // The one intended difference: big.txt is left out of the reference copy but
      // listed virtually (max_file_bytes is enforced by read only).
      expect(text(b).split("\n").filter((l) => l !== "big.txt")).toEqual(text(a).split("\n"));
    }
    expect(text(await run(t.ls, { path: virtual }))).not.toMatch(/node_modules/);
  });

  it("answers the per-entry stats from ONE tree listing per directory", async () => {
    const view = newView();
    const spy = vi.spyOn(view, "tree");
    await run(tools(view).ls, { path: path.join(virtual, "src") });
    // root (to find `src`) + src itself — not one call per entry.
    expect(new Set(spy.mock.calls.map((c) => c[1])).size).toBe(2);
  });

  it("an excluded or missing directory is refused with the reason", async () => {
    await expect(run(tools().ls, { path: path.join(virtual, "node_modules") })).rejects.toThrow(/excluded/);
    await expect(run(tools().ls, { path: path.join(virtual, "nope") })).rejects.toThrow(/does not exist/);
    await expect(run(tools().ls, { path: path.join(virtual, "README.md") })).rejects.toThrow(/Not a directory/);
  });
});

describe("find on a virtual path", () => {
  it.each(["*.ts", "**/*.ts", "src/**", "**/[[]id]/*", "**/*.{ts,tsx}", "*", "**/util", ".*"])(
    "matches exactly what the physical glob matches: %s",
    async (pattern) => {
      const t = tools();
      const a = text(await run(t.find, { pattern, path: physical })).split("\n").sort();
      const b = text(await run(t.find, { pattern, path: virtual })).split("\n").filter((l) => l !== "big.txt").sort();
      expect(b).toEqual(a);
    },
  );

  it("never shows excluded directories", async () => {
    // node_modules/pkg/index.js and web/dist/bundle.js are in the commit; only web/app.js is visible.
    const out = text(await run(tools().find, { pattern: "**/*.js", path: virtual }));
    expect(out).toBe("web/app.js");
  });

  it("honours the limit with pi's notice", async () => {
    const out = text(await run(tools().find, { pattern: "**/*", path: virtual, limit: 3 }));
    expect(out.split("\n\n")[0].split("\n")).toHaveLength(3);
    expect(out).toContain("[3 results limit reached]");
  });

  it("a search path that is a file is refused", async () => {
    await expect(run(tools().find, { pattern: "*", path: path.join(virtual, "README.md") })).rejects.toThrow(/is a file/);
  });
});

// ── grep ─────────────────────────────────────────────────────────────────────

describe("compileRgGlob", () => {
  const cwd = "/app";
  const rootDir = "/app/.siclaw/repos/app@abc1234";
  it("no slash: matches the basename at any depth, dotfiles included, case-sensitive", () => {
    const g = compileRgGlob("*.ts", cwd);
    expect(g.accepts(`${rootDir}/a.ts`, rootDir)).toBe(true);
    expect(g.accepts(`${rootDir}/x/y/.h.ts`, rootDir)).toBe(true);
    expect(g.accepts(`${rootDir}/x/A.TS`, rootDir)).toBe(false);
    expect(g.simpleBasename).toBe("*.ts");
  });
  it("braces are supported and disable the pathspec pushdown", () => {
    const g = compileRgGlob("*.{ts,tsx}", cwd);
    expect(g.accepts(`${rootDir}/a.tsx`, rootDir)).toBe(true);
    expect(g.simpleBasename).toBeNull();
  });
  it("a slash anchors at the process cwd, not at the search path", () => {
    expect(compileRgGlob("src/*.ts", cwd).accepts(`${rootDir}/src/a.ts`, rootDir)).toBe(false);
    expect(compileRgGlob(".siclaw/repos/app@abc1234/src/*.ts", cwd).accepts(`${rootDir}/src/a.ts`, rootDir)).toBe(true);
    expect(compileRgGlob("**/src/*.ts", cwd).accepts(`${rootDir}/src/a.ts`, rootDir)).toBe(true);
  });
  it("a negated glob excludes a matching file or anything under a matching directory below the root", () => {
    const g = compileRgGlob("!docs", cwd);
    expect(g.accepts(`${rootDir}/docs/a.md`, rootDir)).toBe(false);
    expect(g.accepts(`${rootDir}/src/a.md`, rootDir)).toBe(true);
    expect(compileRgGlob("!*.md", cwd).accepts(`${rootDir}/src/a.md`, rootDir)).toBe(false);
  });
});

const rgAvailable = spawnSync("rg", ["--version"]).error === undefined;

describe("grep on a virtual path", () => {
  it("searches the commit, not the branch head", async () => {
    const out = text(await run(tools().grep, { pattern: "needle", path: path.join(virtual, "src/main.ts") }));
    expect(out).toContain("main.ts:2: // needle: first");
    expect(out).not.toContain("changed");
  });

  it("never searches excluded directories or binary files", async () => {
    const out = text(await run(tools().grep, { pattern: "needle", path: virtual }));
    expect(out).not.toMatch(/node_modules|bundle\.js|bin\.dat/);
  });

  it("stops git grep at the limit (not after walking the whole tree)", async () => {
    const r = await run(tools().grep, { pattern: "many", path: virtual, limit: 5 });
    expect(text(r)).toContain("[5 matches limit reached. Use limit=10 for more, or refine pattern]");
    expect(r.details).toMatchObject({ matchLimitReached: 5 });
  });

  it("refusals carry their reason", async () => {
    await expect(run(tools().grep, { pattern: "x", path: path.join(virtual, "nope") })).rejects.toThrow(/does not exist/);
    await expect(run(tools().grep, { pattern: "x", path: path.join(virtual, "node_modules") })).rejects.toThrow(/excluded/);
    await expect(run(tools().grep, { pattern: "(", path: virtual })).rejects.toThrow();
  });

  it.skipIf(!rgAvailable)("a physical path still goes to pi's own grep (needs rg)", async () => {
    const out = text(await run(tools().grep, { pattern: "needle", path: path.join(physical, "docs") }));
    expect(out).toBe("guide.md:1: needle in docs");
  });
});

/**
 * 🔴 The contract: the same query over the physical tree (pi's grep → real
 * ripgrep) and over the same commit (git grep) produces BYTE-IDENTICAL results.
 *
 * rg walks files in parallel, so its order is not defined; `--sort=path` is
 * injected through RIPGREP_CONFIG_PATH (pi passes no config of its own) so the
 * comparison is exact rather than set-wise. process.cwd() is moved to the
 * fixture root because rg anchors slash-globs at its cwd, which pi never sets.
 */
describe.skipIf(!rgAvailable)(
  `grep contract: physical (ripgrep) ≡ virtual (git grep)${rgAvailable ? "" : " — SKIPPED: rg is not on PATH, so pi's physical grep cannot run"}`,
  () => {
  const savedRgConfig = process.env.RIPGREP_CONFIG_PATH;
  beforeAll(() => {
    const cfg = path.join(root, "rg.conf");
    fs.writeFileSync(cfg, "--sort=path\n");
    process.env.RIPGREP_CONFIG_PATH = cfg;
    process.chdir(root);
  });
  afterAll(() => {
    process.chdir(savedCwd);
    if (savedRgConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
    else process.env.RIPGREP_CONFIG_PATH = savedRgConfig;
  });

  /** `rel` is the search path below the view root; `glob` may mention the view dir as `<view>`. */
  // `empty: true` marks the cases whose correct answer IS "No matches found";
  // every other case must find something, so two identical failures cannot pass.
  const cases: Array<[string, { rel?: string; glob?: string; empty?: true } & Record<string, unknown>]> = [
    ["plain regex over the whole tree", { pattern: "needle" }],
    ["a subdirectory", { pattern: "needle", rel: "src" }],
    ["a directory with glob characters in its name", { pattern: "needle", rel: "src/[id]" }],
    ["ignoreCase", { pattern: "NEEDLE", ignoreCase: true }],
    ["literal", { pattern: "a.b", literal: true }],
    ["regex metacharacters", { pattern: "a.b" }],
    ["alternation and groups", { pattern: "need(le)+|axb" }],
    ["context lines", { pattern: "needle", context: 2 }],
    ["context in a CRLF file", { pattern: "needle", rel: "crlf.txt", context: 1 }],
    ["glob *.ts", { pattern: "needle", glob: "*.ts" }],
    ["glob with braces", { pattern: "needle", glob: "*.{ts,tsx}" }],
    ["glob *.tsx under a bracketed dir (escaped pushdown)", { pattern: "needle", rel: "src/[id]", glob: "*.tsx" }],
    ["negated glob", { pattern: "needle", glob: "!*.md" }],
    ["negated directory glob", { pattern: "needle", glob: "!src" }],
    ["**/ glob", { pattern: "needle", glob: "**/util/*.ts" }],
    ["slash glob relative to the SEARCH path (matches nothing: rg anchors at its cwd)", { pattern: "needle", glob: "src/*.ts", empty: true }],
    ["slash glob relative to rg's cwd", { pattern: "needle", glob: ".siclaw/repos/<view>/src/*.ts" }],
    ["a single file", { pattern: "needle", rel: "src/main.ts" }],
    ["a single file ignores glob", { pattern: "needle", rel: "src/main.ts", glob: "*.md" }],
    ["a dotfile", { pattern: "needle", rel: ".hidden.ts" }],
    ["an explicit limit", { pattern: "needle", limit: 3 }],
    ["the default limit of 100", { pattern: "many" }],
    ["a line over 500 chars is truncated", { pattern: "needle", rel: "long.txt" }],
    ["no matches", { pattern: "zzz-not-there", empty: true }],
  ];

  it.each(cases)("%s", async (_label, { rel, glob, empty, ...params }) => {
    const t = tools();
    const call = (viewRoot: string) => run(t.grep, {
      ...params,
      path: rel ? path.join(viewRoot, rel) : viewRoot,
      ...(glob ? { glob: glob.replace("<view>", path.basename(viewRoot)) } : {}),
    });
    const physicalResult = await call(physical);
    const virtualResult = await call(virtual);
    expect(text(physicalResult) === "No matches found").toBe(!!empty);
    expect(virtualResult).toEqual(physicalResult);
  });
},
);
