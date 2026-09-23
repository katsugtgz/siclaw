/**
 * The ONE way the AgentBox runs git: against a read-only bare mirror, for the
 * code-view layer (virtual `<repo>@<sha>` paths in the file tools) and for
 * `git_query`. See docs/design/agentbox-code-volume.md ("Git layer").
 *
 * The agent never supplies a command line here — callers build argv from
 * validated parts — but git reads a great deal of ambient state on its own, and
 * several of those inputs execute programs. Everything below pins that state:
 *
 *   - argv only, never a shell;
 *   - an environment built from an allow-list, not a sanitised copy of ours:
 *     nothing of the box's (credentials dirs, proxy settings, GIT_* the image
 *     might carry) reaches the child;
 *   - system and global config disabled (`GIT_CONFIG_NOSYSTEM`,
 *     `GIT_CONFIG_GLOBAL=/dev/null`, `HOME=/tmp`); the repository's own config
 *     is the supplier's and is additionally overridden, key by key, by the fixed
 *     `-c` prefix for everything that could run code or write;
 *   - `GIT_NO_REPLACE_OBJECTS=1`: `refs/replace/*` in a mirror would otherwise
 *     silently substitute one object for another — the SHA the agent cites
 *     would not be the content it read;
 *   - a timeout, an output cap and a per-box concurrency gate, because the mirrors
 *     sit on NFS and the agent decides how often to ask.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** Wall-clock limit for one git process. */
export const GIT_TIMEOUT_MS = 20_000;

/** Default ceiling on captured stdout for a buffered call. */
export const GIT_DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Default number of git processes one box runs at once. */
export const GIT_DEFAULT_CONCURRENCY = 4;

/**
 * The fixed prefix every invocation carries, before `--git-dir`.
 *
 * - `safe.directory=*`: the mirrors belong to the supplier's uid, not the box's;
 *   without it git refuses the repository outright ("dubious ownership"). It is
 *   only honoured from protected config, which the command line is.
 * - `gc.auto=0` / `maintenance.auto=0`: a READER must never repack a pool other
 *   boxes are reading over NFS (the mount is read-only, but a failed attempt
 *   still costs a scan and leaves noise).
 * - `core.fsmonitor=false` / `core.hooksPath=/dev/null`: both name programs git
 *   would run.
 * - `protocol.allow=never`: nothing here ever talks to a remote; a lazy fetch
 *   from a partial clone would otherwise try to.
 */
export const GIT_FIXED_PREFIX: readonly string[] = Object.freeze([
  "--no-pager",
  "-c", "safe.directory=*",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=0",
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.allow=never",
]);

/** Full argv for `git` against one bare repository. */
export function gitArgv(gitDir: string, args: readonly string[]): string[] {
  return [...GIT_FIXED_PREFIX, "--git-dir", gitDir, ...args];
}

/**
 * The child's ENTIRE environment. PATH is the only value taken from ours, and
 * only so `git` (and the helpers it execs from its own exec-path) resolve.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    HOME: "/tmp",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

/**
 * Counting semaphore. FIFO, so a burst of `ls` stats cannot starve a `read`
 * that arrived first.
 */
export class GitGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`GitGate limit must be a positive integer, got ${limit}`);
  }
  get running(): number { return this.active; }
  get queued(): number { return this.waiting.length; }
  /**
   * Wait for a slot. `waitMs` bounds the wait: a slot is released only when its
   * git process EXITS, and a process stuck on a hung NFS mount (uninterruptible
   * sleep) never exits — so without a bound, once every slot is held that way,
   * every later read in the box would queue forever instead of failing.
   */
  async acquire(signal?: AbortSignal, waitMs?: number): Promise<() => void> {
    if (signal?.aborted) throw new Error("Operation aborted");
    if (this.active < this.limit) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const leave = () => {
        const i = this.waiting.indexOf(go);
        if (i >= 0) this.waiting.splice(i, 1);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        leave();
        reject(new Error("Operation aborted"));
      };
      const go = () => {
        leave();
        resolve();
      };
      this.waiting.push(go);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (waitMs !== undefined) {
        timer = setTimeout(() => {
          leave();
          reject(new GitGateBusyError(this.limit, waitMs));
        }, waitMs);
      }
    });
    this.active++;
    return this.releaser();
  }
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

/** One gate per box process: every session, tool and git_query shares it. */
export const boxGitGate = new GitGate(GIT_DEFAULT_CONCURRENCY);

/** git ran and exited with a code the caller did not accept. */
export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args[0] ?? ""} failed (exit ${exitCode}): ${stderr.trim() || "(no stderr)"}`);
    this.name = "GitCommandError";
  }
}

/**
 * Every git slot of the box stayed busy for a whole timeout. With the timeout far
 * above any healthy git call, this means git processes are stuck — in practice,
 * on a hung NFS mount — and it is reported as such rather than as a slow repository.
 */
export class GitGateBusyError extends Error {
  constructor(readonly limit: number, readonly waitMs: number) {
    super(
      `all ${limit} git slots of this box stayed busy for ${Math.round(waitMs / 1000)}s; ` +
      `git processes appear to be stuck on the code volume, so no commit can be read right now`,
    );
    this.name = "GitGateBusyError";
  }
}

/** git did not finish within its time limit and was killed. */
export class GitTimeoutError extends Error {
  constructor(readonly args: readonly string[], readonly timeoutMs: number) {
    super(`git ${args[0] ?? ""} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`);
    this.name = "GitTimeoutError";
  }
}

export interface RunGitOptions {
  /** Exit codes that count as success. Default `[0]`. */
  okCodes?: readonly number[];
  /** Stdout ceiling; past it the child is killed and `truncated` is set. */
  maxOutputBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  gate?: GitGate;
}

export interface RunGitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
  /** Stdout hit `maxOutputBytes`: what is here is a PREFIX, never the whole answer. */
  truncated: boolean;
}

const STDERR_CAP_BYTES = 64 * 1024;

export interface StreamGitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  gate?: GitGate;
  /** Receives stdout as it arrives. May call `stop()` on the handle to end early. */
  onStdout: (chunk: Buffer) => void;
}

export interface StreamGitHandle {
  /** Kill the child on purpose (e.g. a match limit was reached). Resolves normally. */
  stop(): void;
  /** Settles after the child exits (and the gate slot is released). */
  done: Promise<{ exitCode: number | null; stderr: string; stopped: boolean }>;
}

/**
 * Stream a git process's stdout. For `git grep`, which must be killed the moment
 * enough matches arrived rather than after it has walked the whole tree.
 *
 * Rejects with `GitTimeoutError` / "Operation aborted" / spawn errors; resolves
 * with the exit code otherwise — which exit codes mean success is the caller's
 * call (`git grep` answers 1 for "no match").
 */
export function streamGit(gitDir: string, args: readonly string[], opts: StreamGitOptions): StreamGitHandle {
  const gate = opts.gate ?? boxGitGate;
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  let child: ChildProcess | undefined;
  let stopped = false;
  const handle: StreamGitHandle = {
    stop: () => {
      stopped = true;
      if (child && child.exitCode === null && !child.killed) child.kill("SIGKILL");
    },
    done: (async () => {
      const release = await gate.acquire(opts.signal, timeoutMs);
      if (stopped) {
        release();
        return { exitCode: null, stderr: "", stopped: true };
      }
      return await new Promise<{ exitCode: number | null; stderr: string; stopped: boolean }>((resolve, reject) => {
        let c: ChildProcess;
        try {
          c = spawn("git", gitArgv(gitDir, args), {
            cwd: "/",
            env: gitEnv(),
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (err) {
          release();
          reject(new Error(`Failed to run git: ${(err as Error).message}`));
          return;
        }
        child = c;
        let stderr = "";
        // 🔴 The CALLER is settled by whichever comes first — exit, timeout, abort —
        // but the gate slot is released only when the process is gone ("close").
        // A git blocked on a hung NFS mount ignores SIGKILL until the kernel lets it
        // go; waiting for its "close" hung the tool call and made Stop useless, and
        // releasing its slot early would let such processes pile up without bound.
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          finish();
        };
        const timer = setTimeout(() => {
          c.kill("SIGKILL");
          // A child we stopped on purpose that is merely slow to die is still a success.
          settle(() => (stopped
            ? resolve({ exitCode: null, stderr, stopped: true })
            : reject(new GitTimeoutError(args, timeoutMs))));
        }, timeoutMs);
        const onAbort = () => {
          c.kill("SIGKILL");
          settle(() => reject(new Error("Operation aborted")));
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        c.stdout!.on("data", (chunk: Buffer) => {
          if (!stopped && !settled) opts.onStdout(chunk);
        });
        c.stderr!.on("data", (chunk: Buffer) => {
          if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString("utf8");
        });
        c.on("error", (err) => {
          // Node emits "close" after a spawn "error" as well; release is idempotent either way.
          release();
          settle(() => reject(new Error(`Failed to run git: ${err.message}`)));
        });
        c.on("close", (code) => {
          release();
          settle(() => resolve({ exitCode: code, stderr, stopped }));
        });
      });
    })(),
  };
  return handle;
}

/**
 * Run git to completion and capture stdout as bytes (blobs are not text, and
 * `-z` output must be split on NUL before any decoding).
 *
 * Throws `GitCommandError` for an exit code outside `okCodes`, `GitTimeoutError`
 * on timeout. Hitting `maxOutputBytes` is NOT an error — it kills the child and
 * returns `truncated: true` with whatever prefix arrived, so the caller decides
 * whether a prefix is usable (git_query's capped output) or a failure (a blob).
 */
export async function runGit(gitDir: string, args: readonly string[], opts: RunGitOptions = {}): Promise<RunGitResult> {
  const okCodes = opts.okCodes ?? [0];
  const max = opts.maxOutputBytes ?? GIT_DEFAULT_MAX_OUTPUT_BYTES;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const handle: StreamGitHandle = streamGit(gitDir, args, {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    gate: opts.gate,
    onStdout: (chunk) => {
      if (truncated) return;
      if (size + chunk.length > max) {
        chunks.push(chunk.subarray(0, max - size));
        size = max;
        truncated = true;
        handle.stop();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
  });
  const { exitCode, stderr } = await handle.done;
  const stdout = Buffer.concat(chunks, size);
  if (truncated) return { exitCode: exitCode ?? -1, stdout, stderr, truncated };
  if (exitCode === null || !okCodes.includes(exitCode)) throw new GitCommandError(args, exitCode, stderr);
  return { exitCode, stdout, stderr, truncated };
}
