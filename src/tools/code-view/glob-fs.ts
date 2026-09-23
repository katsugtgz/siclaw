/**
 * An in-memory filesystem for `glob`'s `fs` option.
 *
 * Both glob-shaped questions the code-view layer answers — `find` over a
 * commit's listing, and rg's `--glob` filter in `grep` — are handed to the same
 * `glob` library the physical tools use, over a filesystem made of paths we
 * already know. That keeps ONE matcher (`*`, `?`, `[…]`, `{a,b}`, `**`, dot and
 * ignore handling) instead of a second, hand-written one that would agree on the
 * common patterns and quietly diverge on the rest.
 *
 * Only what path-scurry calls on a synchronous walk is implemented. Symlinks are
 * reported as symlinks and never followed (`readlinkSync` refuses), so `**`
 * does not descend through them — which is also glob's default on disk.
 */
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

export type GlobFsKind = "dir" | "file" | "symlink";

type Callback = (err: NodeJS.ErrnoException | null, entries?: Dirent[]) => void;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: code-view virtual filesystem`), { code });
}

function typeMethods(kind: GlobFsKind) {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

/**
 * Build the filesystem from absolute paths and their kinds. Every ancestor of
 * every path becomes a directory, up to `/`, so a walk may start anywhere above.
 */
export function createGlobFs(nodes: Iterable<readonly [string, GlobFsKind]>) {
  const kinds = new Map<string, GlobFsKind>();
  const children = new Map<string, Map<string, GlobFsKind>>();
  const add = (abs: string, kind: GlobFsKind) => {
    kinds.set(abs, kind);
    if (kind === "dir" && !children.has(abs)) children.set(abs, new Map());
    for (let cur = abs; path.dirname(cur) !== cur; cur = path.dirname(cur)) {
      const parent = path.dirname(cur);
      if (!children.has(parent)) children.set(parent, new Map());
      children.get(parent)!.set(path.basename(cur), kinds.get(cur)!);
      if (kinds.has(parent)) break;
      kinds.set(parent, "dir");
    }
  };
  for (const [abs, kind] of nodes) add(path.resolve(abs), kind);

  const readdirSync = (p: string): Dirent[] => {
    const resolved = path.resolve(p);
    const listing = children.get(resolved);
    if (!listing) throw errno(kinds.has(resolved) ? "ENOTDIR" : "ENOENT");
    return [...listing].map(([name, kind]) =>
      ({ name, parentPath: resolved, path: resolved, ...typeMethods(kind) }) as unknown as Dirent);
  };
  return {
    lstatSync: (p: string): Stats => {
      const kind = kinds.get(path.resolve(p));
      if (!kind) throw errno("ENOENT");
      const epoch = new Date(0);
      return {
        dev: 0, ino: 0, mode: 0, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0, blksize: 0, blocks: 0,
        atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0, atime: epoch, mtime: epoch, ctime: epoch, birthtime: epoch,
        ...typeMethods(kind),
      } as unknown as Stats;
    },
    readdirSync,
    readdir: (p: string, _options: unknown, cb: Callback) => {
      let entries: Dirent[];
      try {
        entries = readdirSync(p);
      } catch (err) {
        // Node's callback contract: the error goes to the callback, not up the stack.
        cb(err as NodeJS.ErrnoException);
        return;
      }
      cb(null, entries);
    },
    readlinkSync: (): string => { throw errno("EINVAL"); },
    realpathSync: (p: string): string => {
      const resolved = path.resolve(p);
      if (!kinds.has(resolved)) throw errno("ENOENT");
      return resolved;
    },
  };
}
