import { describe, expect, it } from "vitest";
import {
  CodeViewManifestError,
  bareShapeProblem,
  isExcludedPath,
  parseCodeViewManifest,
} from "./code-view-manifest.js";

const RULES = { exclude_dirs: ["node_modules", "vendor", "dist", "target"], max_file_bytes: 5242880 };
const doc = (repos: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, updated_at: "2026-09-23T00:00:00Z", repos, rules: RULES, ...extra });

describe("parseCodeViewManifest", () => {
  it("reads the schema the supplier writes", () => {
    const m = parseCodeViewManifest(doc([
      { name: "siforge-demo", host: "gitlab.x", path: "qliu/siforge-demo", bare: "mirrors/gitlab.x/qliu/siforge-demo.git" },
    ]));
    expect(m.repos).toEqual([
      { name: "siforge-demo", host: "gitlab.x", path: "qliu/siforge-demo", bare: "mirrors/gitlab.x/qliu/siforge-demo.git" },
    ]);
    expect(m.rules).toEqual({ excludeDirs: ["node_modules", "vendor", "dist", "target"], maxFileBytes: 5242880 });
    expect(m.rejected).toEqual([]);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["no version", JSON.stringify({ repos: [], rules: RULES })],
    ["a future version", JSON.stringify({ version: 2, repos: [], rules: RULES })],
    ["repos missing", JSON.stringify({ version: 1, rules: RULES })],
    ["rules missing", JSON.stringify({ version: 1, repos: [] })],
    ["exclude_dirs with a path", JSON.stringify({ version: 1, repos: [], rules: { exclude_dirs: ["a/b"], max_file_bytes: 1 } })],
    ["a zero size cap", JSON.stringify({ version: 1, repos: [], rules: { exclude_dirs: [], max_file_bytes: 0 } })],
    ["a fractional size cap", JSON.stringify({ version: 1, repos: [], rules: { exclude_dirs: [], max_file_bytes: 1.5 } })],
  ])("refuses the whole document when it has %s", (_label, text) => {
    expect(() => parseCodeViewManifest(text)).toThrow(CodeViewManifestError);
  });

  it("drops a bad entry and keeps the rest, saying why", () => {
    const m = parseCodeViewManifest(doc([
      "nope",
      { name: "", host: "h", path: "p", bare: "mirrors/h/p.git" },
      { name: "a", host: "", path: "p", bare: "mirrors/h/p.git" },
      { name: "b", host: "h", path: "p", bare: 7 },
      { name: "c", host: "h", path: "p", bare: "mirrors/h/../x.git" },
      { name: "ok", host: "h", path: "ok", bare: "mirrors/h/ok.git" },
    ]));
    expect(m.repos.map((r) => r.name)).toEqual(["ok"]);
    expect(m.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("drops EVERY party to a name or bare collision (no first-one-wins)", () => {
    const m = parseCodeViewManifest(doc([
      { name: "dup", host: "h", path: "a", bare: "mirrors/h/a.git" },
      { name: "dup", host: "h", path: "b", bare: "mirrors/h/b.git" },
      { name: "x", host: "h", path: "c", bare: "mirrors/h/c.git" },
      { name: "y", host: "h", path: "c", bare: "mirrors/h/c.git" },
      { name: "ok", host: "h", path: "ok", bare: "mirrors/h/ok.git" },
    ]));
    expect(m.repos.map((r) => r.name)).toEqual(["ok"]);
    expect(m.rejected.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });
});

describe("bareShapeProblem", () => {
  it.each([
    "mirrors/gitlab.x/grp/app.git",
    "mirrors/gitlab.x/a/b/c/app.git",
  ])("accepts %s", (bare) => expect(bareShapeProblem(bare)).toBeNull());

  it.each([
    "mirrors/app.git",           // no host
    "pool/gitlab.x/app.git",     // not the mirror pool
    "mirrors/gitlab.x/app",      // not a bare repo name
    "mirrors/gitlab.x/.git",     // no repo name before .git
    "mirrors/gitlab.x/../app.git",
    "mirrors/gitlab.x/./app.git",
    "mirrors/gitlab.x//app.git",
    "/mirrors/gitlab.x/app.git",
    "mirrors/gitlab.x/-app.git", // would read as a git option in argv
    "mirrors/gitlab.x:8443/app.git",
  ])("refuses %s", (bare) => expect(bareShapeProblem(bare)).not.toBeNull());
});

describe("isExcludedPath", () => {
  const rules = { excludeDirs: ["node_modules", "dist"], maxFileBytes: 1 };
  it("matches an excluded name at any depth, as the writer does", () => {
    expect(isExcludedPath("node_modules/x.js", rules)).toBe(true);
    expect(isExcludedPath("web/node_modules/x/y.js", rules)).toBe(true);
    expect(isExcludedPath("dist", rules)).toBe(true);
  });
  it("does not match substrings or the repository root", () => {
    expect(isExcludedPath("distance/x.go", rules)).toBe(false);
    expect(isExcludedPath("src/my_node_modules.md", rules)).toBe(false);
    expect(isExcludedPath("", rules)).toBe(false);
  });
});
