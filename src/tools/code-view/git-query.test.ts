/**
 * git_query against REAL git: a bare mirror built in a temp dir and mounted
 * where the box would see it. Contract: docs/design/agentbox-code-volume.md
 * ("Git layer" → "git_query").
 */
import { vi } from "vitest";
// Pass-through spy: every call still runs real git, and the argv each op
// builds can be pinned — that argv IS the hardening.
vi.mock("./git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git.js")>();
  return { ...actual, runGit: vi.fn(actual.runGit) };
});
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "./git.js";
import { CodeView } from "./view.js";
import { GIT_QUERY_MAX_OUTPUT_BYTES, createGitQueryTool, normaliseRepoPath, refProblem, registration, type GitQueryParams } from "./git-query.js";
import type { ToolRefs } from "../../core/tool-registry.js";

const MAX_FILE_BYTES = 4096;

let root: string;
let reposDir: string;
let gitReposDir: string;
let bare: string;
let c1: string;
let c2: string;
let c3: string;
let view: CodeView;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=Tester", "-c", "commit.gpgsign=false", ...args], { cwd })
    .toString().trim();
}
function write(dir: string, rel: string, content: string) {
  fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}
function writeManifest(names: string[]) {
  fs.writeFileSync(path.join(reposDir, ".gitrepos.json"), JSON.stringify({
    version: 1,
    updated_at: "t",
    repos: names.map((name) => ({ name, host: "gitlab.x", path: `grp/${name}`, bare: `mirrors/gitlab.x/grp/${name}.git` })),
    rules: { exclude_dirs: ["node_modules"], max_file_bytes: MAX_FILE_BYTES },
  }));
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-query-")));
  reposDir = path.join(root, ".siclaw", "repos");
  gitReposDir = path.join(root, ".siclaw", "gitrepos");
  fs.mkdirSync(reposDir, { recursive: true });
  fs.mkdirSync(gitReposDir, { recursive: true });
  const work = path.join(root, "work");
  git(root, "init", "-q", "-b", "main", work);
  write(work, "README.md", "# app\n");
  write(work, "src/main.ts", "line one\nline two\nline three\n");
  write(work, "node_modules/pkg/index.js", "module.exports = 1;\n");
  write(work, "big.txt", "b".repeat(MAX_FILE_BYTES + 1));
  git(work, "add", "-A");
  git(work, "commit", "-qm", "first commit");
  c1 = git(work, "rev-parse", "HEAD");
  git(work, "tag", "-a", "v1", "-m", "release one");
  git(work, "checkout", "-q", "-b", "feature");
  write(work, "src/main.ts", "line one\nline two has a needle\nline three\n");
  write(work, "node_modules/pkg/index.js", "module.exports = 2;\n");
  git(work, "commit", "-qam", "add the needle");
  c2 = git(work, "rev-parse", "HEAD");
  // Big enough that its patch alone overflows the 256 KiB cap.
  write(work, "huge.txt", Array.from({ length: 12_000 }, (_, i) => `row ${i} ${"x".repeat(20)}`).join("\n") + "\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "add a huge file");
  c3 = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "main");
  bare = path.join(gitReposDir, "app.git");
  git(root, "clone", "-q", "--bare", work, bare);
  // MR heads are fetched by the supplier as refs/mr/<iid>.
  git(bare, "update-ref", "refs/mr/7", c2);
  writeManifest(["app"]);
  view = new CodeView({ reposDir, gitReposDir, authorityTtlMs: 0 });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(runGit).mockClear();
});

type Result = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
async function query(params: Partial<GitQueryParams>): Promise<Result> {
  const tool = createGitQueryTool(view);
  return await tool.execute("call", { repo: "app", ...params }, undefined, undefined, undefined as never) as unknown as Result;
}
const text = (r: Result) => r.content.map((c) => c.text).join("");
const errorOf = (r: Result) => {
  expect(r.details.error, `expected an error result, got: ${text(r)}`).toBe(true);
  return { reason: r.details.reason, message: (JSON.parse(text(r)) as { error: string }).error };
};
/** The argv of the last git call (after the fixed prefix, which git.test.ts pins). */
const lastArgs = () => vi.mocked(runGit).mock.calls.at(-1)![1] as string[];

describe("refs", () => {
  it("lists branches, tags (peeled to their commit) and MR heads with the commit each names", async () => {
    const r = await query({ op: "refs" });
    expect(r.details.error).toBeUndefined();
    const rows = text(r).split("\n");
    expect(rows).toEqual(expect.arrayContaining([
      `${c1}\trefs/heads/main`,
      `${c3}\trefs/heads/feature`,
      `${c1}\trefs/tags/v1`,
      `${c2}\trefs/mr/7`,
    ]));
    expect(rows).toHaveLength(4);
  });

  it("filters by substring and marks what the limit left out", async () => {
    expect(text(await query({ op: "refs", pattern: "mr/" }))).toBe(`${c2}\trefs/mr/7`);
    // A ref-prefix pattern is pushed down to for-each-ref (a repository with tens of
    // thousands of MR heads stays listable by narrowing) and gives the same answer.
    expect(text(await query({ op: "refs", pattern: "refs/mr/" }))).toBe(`${c2}\trefs/mr/7`);
    expect(text(await query({ op: "refs", pattern: "refs/heads/feat" }))).toBe(`${c3}\trefs/heads/feature`);
    expect(text(await query({ op: "refs", pattern: "nothing-like-this" }))).toContain("no ref");
    const limited = text(await query({ op: "refs", limit: 1 }));
    expect(limited.split("\n")[0]).toMatch(/^[0-9a-f]{40}\trefs\//);
    expect(limited).toContain("[3 more refs not shown. Narrow with pattern.]");
  });
});

describe("log", () => {
  it("defaults to HEAD (the default branch) and names the SHA a symbolic ref resolved to", async () => {
    const out = text(await query({ op: "log" }));
    expect(out.split("\n")[0]).toBe(`HEAD = ${c1}`);
    expect(out).toMatch(new RegExp(`^${c1} \\S+ Tester\\tfirst commit$`, "m"));
    expect(out).not.toContain("add the needle");
  });

  it("follows ref, ~N navigation, path and limit", async () => {
    const feature = text(await query({ op: "log", ref: "feature", limit: 2 }));
    expect(feature).toContain(`feature = ${c3}`);
    expect(feature).toContain("add a huge file");
    expect(feature).toContain("add the needle");
    expect(feature).not.toContain("first commit");
    expect(text(await query({ op: "log", ref: "feature~1", path: "src/main.ts" }))).toContain("add the needle");
    // A full SHA needs no "name = sha" line: it already is the answer.
    expect(text(await query({ op: "log", ref: c2, path: "README.md" }))).toMatch(new RegExp(`^${c1} `));
  });

  it("finds commits by content (-S) and message (--grep) only when scoped", async () => {
    expect(text(await query({ op: "log", ref: "feature", search: "needle", path: "src" }))).toContain("add the needle");
    expect(text(await query({ op: "log", ref: "feature", grep: "huge", limit: 5 }))).toContain("add a huge file");
    vi.mocked(runGit).mockClear();
    const unscoped = errorOf(await query({ op: "log", ref: "feature", search: "needle" }));
    expect(unscoped.reason).toBe("invalid_argument");
    expect(unscoped.message).toMatch(/path.*limit/);
    // Refused before any git process ran.
    expect(vi.mocked(runGit)).not.toHaveBeenCalled();
  });

  it("bounds limit", async () => {
    expect(errorOf(await query({ op: "log", limit: 201 })).reason).toBe("invalid_argument");
    expect(errorOf(await query({ op: "log", limit: 0 })).reason).toBe("invalid_argument");
  });

  it("pins the hardening flags and puts the resolved SHA after --end-of-options, the path after --", async () => {
    await query({ op: "log", ref: "feature", path: "src/main.ts", search: "--output=/tmp/pwn", limit: 3 });
    const args = lastArgs();
    expect(args[0]).toBe("log");
    expect(args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv", "--no-show-signature", "--no-color"]));
    // The search value is glued to its flag: it can never become an option of its own.
    expect(args).toContain("-S--output=/tmp/pwn");
    expect(args.slice(args.indexOf("--end-of-options"))).toEqual(["--end-of-options", c3, "--", ":(literal)src/main.ts"]);
  });
});

describe("diff", () => {
  it("shows the patch or a stat, without the excluded directories", async () => {
    const patch = text(await query({ op: "diff", from: c1, to: c2 }));
    expect(patch).toContain("+line two has a needle");
    expect(patch).not.toContain("node_modules");
    const stat = text(await query({ op: "diff", from: "v1", to: "refs/mr/7", stat: true }));
    expect(stat).toContain(`v1 = ${c1}`);
    expect(stat).toContain(`refs/mr/7 = ${c2}`);
    expect(stat).toMatch(/src\/main\.ts \| 2 \+-/);
    expect(stat).not.toContain("node_modules");
    expect(text(await query({ op: "diff", from: c1, to: c1 }))).toBe("(no differences)");
    const args = lastArgs();
    expect(args).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
    expect(args.slice(args.indexOf("--end-of-options"), args.indexOf("--") + 1)).toEqual(["--end-of-options", c1, c1, "--"]);
    expect(args).toContain(":(exclude,glob)**/node_modules/**");
  });

  it("requires both sides and refuses an excluded path", async () => {
    expect(errorOf(await query({ op: "diff", from: c1 })).message).toContain('"to" is required');
    const excluded = errorOf(await query({ op: "diff", from: c1, to: c2, path: "node_modules/pkg" }));
    expect(excluded.reason).toBe("excluded");
  });

  it("cuts output past 256 KiB at a line boundary and says so", async () => {
    const r = await query({ op: "diff", from: c2, to: c3 });
    expect(r.details.truncated).toBe(true);
    const out = text(r);
    expect(out).toMatch(/\n\n\[Output truncated at 256 KiB\. Narrow it with path, limit, a line range or stat\.\]$/);
    const body = out.slice(0, out.lastIndexOf("\n\n[Output truncated"));
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(GIT_QUERY_MAX_OUTPUT_BYTES);
    expect(body.split("\n").at(-1)).toMatch(/^\+row \d+ x{20}$/);
  });
});

describe("show", () => {
  it("gives the message, author and per-file summary of one commit", async () => {
    const out = text(await query({ op: "show", ref: "refs/mr/7" }));
    expect(out).toContain(`refs/mr/7 = ${c2}`);
    expect(out).toContain(`commit ${c2}`);
    expect(out).toContain("add the needle");
    expect(out).toMatch(/src\/main\.ts \| 2 \+-/);
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain("+line two has a needle"); // --stat, not the patch
  });

  it("annotated tags resolve to the commit they tag", async () => {
    expect(text(await query({ op: "show", ref: "v1" }))).toContain(`commit ${c1}`);
  });
});

describe("blame", () => {
  it("attributes each line, optionally within a range", async () => {
    const out = text(await query({ op: "blame", ref: "feature", path: "src/main.ts", start_line: 2, end_line: 2 }));
    expect(out).toContain(`feature = ${c3}`);
    const lines = out.split("\n").slice(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^${c2.slice(0, 7)}.*line two has a needle$`));
    const args = lastArgs();
    expect(args).toEqual(["blame", "--no-textconv", "--date=short", "-L", "2,2", c3, "--", "src/main.ts"]);
  });

  it("refuses what read would refuse", async () => {
    expect(errorOf(await query({ op: "blame", ref: c1, path: "node_modules/pkg/index.js" })).reason).toBe("excluded");
    expect(errorOf(await query({ op: "blame", ref: c1, path: "big.txt" })).reason).toBe("too_large");
    expect(errorOf(await query({ op: "blame", ref: c1, path: "src" })).reason).toBe("not_a_file");
    const missing = errorOf(await query({ op: "blame", ref: c1, path: "nope.ts" }));
    expect(missing.reason).toBe("path_not_found");
    expect(missing.message).toContain(c1);
  });

  it("validates the line range", async () => {
    expect(errorOf(await query({ op: "blame", ref: c1, path: "README.md", start_line: 3, end_line: 2 })).reason).toBe("invalid_argument");
    expect(errorOf(await query({ op: "blame", ref: c1 })).message).toContain('"path"');
  });
});

describe("refusals", () => {
  it("names unknown repositories, unreachable SHAs and unknown refs with the next step", async () => {
    const unknown = errorOf(await query({ op: "refs", repo: "other" }));
    expect(unknown.reason).toBe("unknown_repository");
    expect(unknown.message).toContain("app");
    const sha = errorOf(await query({ op: "show", ref: "0123456789abcdef0123456789abcdef01234567" }));
    expect(sha.reason).toBe("ref_unreachable");
    expect(sha.message).toContain("may not have fetched it yet");
    expect(sha.message).toContain('git_query op "refs"');
    expect(sha.message).not.toMatch(/code-mcp/i);
    const ref = errorOf(await query({ op: "log", ref: "no-such-branch" }));
    expect(ref.reason).toBe("ref_unreachable");
    expect(ref.message).toContain('op "refs"');
  });

  it("refuses option-shaped and malformed refs before any git process runs", async () => {
    for (const ref of ["--output=/tmp/x", "-n1", "main..feature", "HEAD@{1}", "a b", "refs/heads/x.lock", "main:README.md", "^main", ""]) {
      const r = await query({ op: "show", ref });
      expect(errorOf(r).reason, ref).toBe("invalid_argument");
    }
    expect(vi.mocked(runGit)).not.toHaveBeenCalled();
  });

  it("refuses paths that are absolute or climb", async () => {
    for (const p of ["/etc/passwd", "../x", "src/../../x", "a//b"]) {
      expect(errorOf(await query({ op: "log", path: p })).reason, p).toBe("invalid_argument");
    }
  });
});

describe("refProblem / normaliseRepoPath", () => {
  it.each(["main", "refs/heads/main", "v1.2.3", "refs/mr/42", "feat/x-y_z", "HEAD", "HEAD~2", "abc1234^", `${"a".repeat(40)}~1^2`, "user@fix"])(
    "accepts %s", (ref) => expect(refProblem(ref)).toBeNull());
  it.each(["-x", ".hidden", "a/.b", "a..b", "x.", "x.lock", "a:b", "a{b", "*", "~1", "a b"])(
    "rejects %s", (ref) => expect(refProblem(ref)).not.toBeNull());
  it("treats the root as no path and keeps a literal path literal", () => {
    expect(normaliseRepoPath("")).toBe("");
    expect(normaliseRepoPath(".")).toBe("");
    expect(normaliseRepoPath("src/")).toBe("src");
    expect(normaliseRepoPath(":(glob)*")).toBe(":(glob)*"); // becomes `:(literal):(glob)*` at the call site
  });
});

describe("registration", () => {
  it("is available only when some repository's history is readable", () => {
    const refs = (codeView?: CodeView) => ({ codeView } as unknown as ToolRefs);
    expect(registration.available!(refs(undefined))).toBe(false);
    expect(registration.available!(refs(view))).toBe(true);
    // Manifest present, nothing mounted: the authority is empty.
    const empty = new CodeView({ reposDir, gitReposDir: path.join(root, "no-mounts"), authorityTtlMs: 0 });
    expect(registration.available!(refs(empty))).toBe(false);
  });
});
