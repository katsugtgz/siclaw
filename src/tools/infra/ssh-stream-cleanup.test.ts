import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ dial: vi.fn(), stream: vi.fn() }));
vi.mock("./ssh-dial.js", async original => ({ ...await original<object>(), dialSshChain: mocks.dial, runCommandStream: mocks.stream }));
import { sshExecStream } from "./ssh-client.js";

describe("streaming SSH abort releases the chain", () => {
  it.each(["signal", "handle"])("releases on %s even without a peer close acknowledgement", async source => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-cancel-fixture-"));
    const passwordPath = path.join(root, "synthetic.password");
    fs.writeFileSync(passwordPath, "synthetic-local-only", { mode: 0o600 });
    const teardown = vi.fn(), abort = vi.fn(), stop = new AbortController();
    const stdout = new PassThrough(), stderr = new PassThrough();
    mocks.dial.mockResolvedValue({ client: {}, teardown });
    mocks.stream.mockResolvedValue({ stdout, stderr, done: new Promise(() => {}), abort });
    try {
      const handle = await sshExecStream({ host: "192.0.2.1", port: 22, username: "fixture", auth: { type: "password", passwordPath } }, "sleep 197", { signal: stop.signal });
      if (source === "signal") stop.abort(); else handle.abort();
      expect(teardown).toHaveBeenCalledTimes(1);
      handle.abort(); stop.abort();
      expect(teardown).toHaveBeenCalledTimes(1);
      expect(abort).toHaveBeenCalled();
    } finally {
      stdout.destroy(); stderr.destroy();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
