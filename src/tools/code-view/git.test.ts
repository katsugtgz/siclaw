import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GIT_FIXED_PREFIX,
  GitCommandError,
  GitGate,
  GitGateBusyError,
  GitTimeoutError,
  gitArgv,
  gitEnv,
  runGit,
  streamGit,
} from "./git.js";

// The whole security argument of the git layer is "argv, allow-listed env, a
// fixed prefix" (docs/design/agentbox-code-volume.md, "Git layer"). These pins
// are what a well-meant "cleanup" of that prefix has to get past.

describe("gitArgv / gitEnv", () => {
  it("carries every fixed -c override, then --git-dir, then the caller's args", () => {
    expect(gitArgv("/m/app.git", ["cat-file", "-t", "abc1234"])).toEqual([
      "--no-pager",
      "-c", "safe.directory=*",
      "-c", "gc.auto=0",
      "-c", "maintenance.auto=0",
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/dev/null",
      "-c", "protocol.allow=never",
      "--git-dir", "/m/app.git",
      "cat-file", "-t", "abc1234",
    ]);
    expect(Object.isFrozen(GIT_FIXED_PREFIX)).toBe(true);
  });

  it("builds the environment from an allow-list — nothing else of ours leaks through", () => {
    const saved = { ...process.env };
    process.env.GIT_DIR = "/elsewhere";
    process.env.GIT_EXEC_PATH = "/evil";
    process.env.SICLAW_CREDENTIALS_DIR = "/app/.siclaw/credentials";
    try {
      expect(gitEnv()).toEqual({
        PATH: process.env.PATH,
        LC_ALL: "C",
        HOME: "/tmp",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      });
    } finally {
      process.env = saved;
    }
  });
});

describe("GitGate", () => {
  it("admits `limit` holders and queues the rest in FIFO order", async () => {
    const gate = new GitGate(2);
    const a = await gate.acquire();
    const b = await gate.acquire();
    const order: string[] = [];
    const c = gate.acquire().then((r) => { order.push("c"); return r; });
    const d = gate.acquire().then((r) => { order.push("d"); return r; });
    expect(gate.running).toBe(2);
    expect(gate.queued).toBe(2);
    a();
    a(); // releasing twice must not free a second slot
    const rc = await c;
    expect(gate.running).toBe(2);
    expect(gate.queued).toBe(1);
    b();
    const rd = await d;
    expect(order).toEqual(["c", "d"]);
    rc();
    rd();
    expect(gate.running).toBe(0);
  });

  it("an aborted waiter leaves the queue without taking a slot", async () => {
    const gate = new GitGate(1);
    const held = await gate.acquire();
    const ac = new AbortController();
    const waiting = gate.acquire(ac.signal);
    ac.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    expect(gate.queued).toBe(0);
    held();
    expect(gate.running).toBe(0);
  });

  it("rejects a nonsensical limit", () => {
    expect(() => new GitGate(0)).toThrow();
  });

  it("a bounded wait fails with GitGateBusyError when no slot frees up — it does not queue forever", async () => {
    // A slot is released only when its process exits; one stuck on a hung NFS
    // mount never does. Once every slot is held that way, waiters must fail.
    const gate = new GitGate(1);
    const held = await gate.acquire();
    await expect(gate.acquire(undefined, 20)).rejects.toBeInstanceOf(GitGateBusyError);
    expect(gate.queued).toBe(0);
    expect(gate.running).toBe(1);
    held();
    expect(gate.running).toBe(0);
  });
});

describe("runGit / streamGit against a real bare repository", () => {
  let dir: string;
  let bare: string;
  let blob: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-view-git-"));
    bare = path.join(dir, "app.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    blob = execFileSync("git", ["--git-dir", bare, "hash-object", "-w", "--stdin"], { input: "x".repeat(10_000) })
      .toString().trim();
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns stdout as bytes", async () => {
    const r = await runGit(bare, ["cat-file", "-t", blob]);
    expect(r.stdout.toString()).toBe("blob\n");
    expect(r.truncated).toBe(false);
  });

  it("throws GitCommandError, with stderr, for an exit code the caller did not accept", async () => {
    const err = await runGit(bare, ["cat-file", "-t", "0".repeat(40)]).catch((e) => e);
    expect(err).toBeInstanceOf(GitCommandError);
    expect((err as GitCommandError).exitCode).not.toBe(0);
    expect((err as GitCommandError).stderr).not.toBe("");
  });

  it("accepts the codes the caller lists", async () => {
    const r = await runGit(bare, ["cat-file", "-e", "0".repeat(40)], { okCodes: [0, 1, 128] });
    expect(r.exitCode).not.toBe(0);
  });

  it("stops at the output cap and says so instead of returning a silent prefix", async () => {
    const r = await runGit(bare, ["cat-file", "blob", blob], { maxOutputBytes: 100 });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(100);
  });

  it("settles the caller at the timeout, and frees the gate slot only once the process has exited", async () => {
    const gate = new GitGate(1);
    await expect(runGit(bare, ["rev-list", "--all"], { timeoutMs: 1, gate })).rejects.toBeInstanceOf(GitTimeoutError);
    // The killed child exits shortly after; its slot comes back then, not never.
    await vi.waitFor(() => expect(gate.running).toBe(0));
  });

  it("kills a process that outlives its timeout", async () => {
    // A 1ms budget is shorter than any git start-up, so the kill always wins.
    await expect(runGit(bare, ["rev-list", "--all"], { timeoutMs: 1 })).rejects.toBeInstanceOf(GitTimeoutError);
  });

  it("streamGit can be stopped on purpose, which is not a failure", async () => {
    let got = 0;
    const h = streamGit(bare, ["cat-file", "blob", blob], {
      onStdout: (chunk) => {
        got += chunk.length;
        h.stop();
      },
    });
    const done = await h.done;
    expect(got).toBeGreaterThan(0);
    expect(done.stopped).toBe(true);
  });

  it("runs with the allow-listed environment, not ours", async () => {
    process.env.GIT_DIR = "/definitely/not/here";
    try {
      const r = await runGit(bare, ["rev-parse", "--git-dir"]);
      expect(r.stdout.toString().trim()).toBe(bare);
    } finally {
      delete process.env.GIT_DIR;
    }
  });
});
