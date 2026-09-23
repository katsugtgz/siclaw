/**
 * Route pi's file-tool operations through the code-view layer.
 *
 * Each wrapper takes the PHYSICAL operations agent-factory already builds (with
 * their allow-list gates) and returns operations that answer virtual
 * `<repo>@<sha>` paths from git and hand everything else to the physical ones
 * unchanged. pi's tools themselves are not touched: their argument handling,
 * sorting, relativising, limits and truncation notices stay pi's, which is what
 * keeps a virtual view's output shaped like a physical one's.
 * See docs/design/agentbox-code-volume.md ("Git layer").
 *
 * `gate` is agent-factory's allow-list check for that tool. A virtual path is
 * always inside `reposDir`, which is on the read allow-list, so the gate can
 * only pass — it is run anyway so the virtual branch has no way around it.
 */
import path from "node:path";
import { globSync } from "glob";
import type { FindOperations, LsOperations, ReadOperations } from "@earendil-works/pi-coding-agent";
import { CodeViewError, type CodeView, type RecursiveEntry, type VirtualLocation } from "./view.js";
import { createGlobFs, type GlobFsKind } from "./glob-fs.js";

type Gate = (absolutePath: string) => void;

export function codeViewReadOps(view: CodeView, physical: ReadOperations, gate: Gate): ReadOperations {
  return {
    ...physical,
    access: async (p) => {
      const loc = view.classify(p);
      if (!loc) return physical.access(p);
      gate(p);
      await view.fileEntry(loc);
    },
    readFile: async (p) => {
      const loc = view.classify(p);
      if (!loc) return physical.readFile(p);
      gate(p);
      return view.readFile(loc);
    },
  };
}

/**
 * pi's `ls` calls `exists`, then `stat` on the directory, then `readdir`, then
 * `stat` on EVERY entry. Only `readdir` costs a git call: `stat` answers from the
 * parent directory's cached tree listing.
 */
export function codeViewLsOps(view: CodeView, physical: LsOperations, gate: Gate): LsOperations {
  return {
    exists: async (p) => {
      const loc = view.classify(p);
      if (!loc) return physical.exists(p);
      gate(p);
      // A refusal (unknown repo, unreachable commit, excluded path, …) is
      // THROWN rather than answered `false`: pi would turn false into a bare
      // "Path not found" and the reason would be lost.
      view.assertNotExcluded(loc, loc.rel);
      if (!(await view.lookup(loc, loc.rel))) throw view.pathNotFound(loc, loc.rel);
      return true;
    },
    stat: async (p) => {
      const loc = view.classify(p);
      if (!loc) return physical.stat(p);
      gate(p);
      const found = await view.lookup(loc, loc.rel);
      if (!found) throw view.pathNotFound(loc, loc.rel);
      // A submodule is a directory in `git archive` output (empty), so it is one here.
      const isDir = found.kind === "root" || found.entry.type !== "blob";
      return { isDirectory: () => isDir };
    },
    readdir: async (p) => {
      const loc = view.classify(p);
      if (!loc) return physical.readdir(p);
      gate(p);
      return (await view.readDir(loc, loc.rel)).map((e) => e.name);
    },
  };
}

// ── find: pi's glob semantics over an in-memory tree ─────────────────────────

function kindOf(e: Pick<RecursiveEntry, "type" | "mode">): GlobFsKind {
  if (e.type === "tree" || e.type === "commit") return "dir";
  return e.mode === "120000" ? "symlink" : "file";
}

/**
 * Run `globSync` — the SAME call, with the SAME options, that agent-factory runs
 * for a physical tree — against a filesystem made of one commit's listing, so
 * the matcher is identical by construction and only the walk's source differs
 * (see glob-fs.ts). Symlinks are listed but not traversed.
 */
export function globVirtual(
  pattern: string,
  searchRoot: string,
  entries: readonly RecursiveEntry[],
  options: { ignore: string[] },
): string[] {
  const nodes: Array<[string, GlobFsKind]> = [[searchRoot, "dir"]];
  for (const e of entries) nodes.push([path.join(searchRoot, ...e.rel.split("/")), kindOf(e)]);
  return globSync(pattern, { cwd: searchRoot, absolute: true, dot: true, ignore: options.ignore, fs: createGlobFs(nodes) });
}

export function codeViewFindOps(view: CodeView, physical: FindOperations, gate: Gate): FindOperations {
  const directory = async (loc: VirtualLocation) => {
    view.assertNotExcluded(loc, loc.rel);
    const found = await view.lookup(loc, loc.rel);
    if (!found) throw view.pathNotFound(loc, loc.rel);
    if (found.kind === "entry" && found.entry.type === "blob") {
      throw new CodeViewError("not_a_directory", `"${loc.rel}" in ${loc.repo.name}@${loc.sha} is a file; find searches a directory.`);
    }
    return found;
  };
  return {
    exists: async (p) => {
      const loc = view.classify(p);
      if (!loc) return physical.exists(p);
      gate(p);
      await directory(loc);
      return true;
    },
    glob: async (pattern, searchCwd, options) => {
      const loc = view.classify(searchCwd);
      if (!loc) return physical.glob(pattern, searchCwd, options);
      gate(searchCwd);
      const found = await directory(loc);
      const entries = found.kind === "entry" && found.entry.type === "commit" ? [] : await view.listRecursive(loc, loc.rel);
      return globVirtual(pattern, path.resolve(searchCwd), entries, { ignore: options.ignore }).slice(0, options.limit);
    },
  };
}
