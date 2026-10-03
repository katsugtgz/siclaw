import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexExecutorPolicy } from "./codex-executor-policy.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-policy-"));
  directories.push(root);
  const read = path.join(root, "read");
  const write = path.join(root, "write");
  const denied = path.join(read, "credentials");
  for (const dir of [read, write, denied]) fs.mkdirSync(dir, { recursive: true });
  return { root, read, write, denied, policy: new CodexExecutorPolicy({
    readRoots: [read], writeRoots: [write], deniedRoots: [denied], allowCommands: true,
    environment: { PATH: "/usr/bin:/bin", SICLAW_CODEX_MODEL_TOKEN: "must-not-reach-child" }, production: false,
  }) };
}
const uri = (value: string) => pathToFileURL(value).href;
const start = (cwd: string, command: string, processId = "process-1") => ({
  processId, argv: ["/bin/bash", "-c", command], cwd: uri(cwd), tty: false, pipeStdin: false,
  env: { OPENAI_API_KEY: "untrusted", KUBECONFIG: "/attacker" },
  envPolicy: { inherit: "all", set: { SECRET: "untrusted" } },
});

describe("Codex native executor policy", () => {
  it("rejects commands before creating process authority and strips caller environment overrides", () => {
    const { policy, read } = fixture();
    expect(() => policy.authorize("process/start", start(read, "touch must-not-exist"))).toThrow();
    expect(() => policy.authorize("process/read", { processId: "process-1" })).toThrow(/session/);
    const authorized = policy.authorize("process/start", start(read, "kubectl version --client"));
    expect(authorized.params.env).toEqual({ PATH: "/usr/bin:/bin", KUBECONFIG: "/dev/null" });
    expect(authorized.params.envPolicy).toMatchObject({ inherit: "none", set: {} });
    expect(() => policy.authorize("process/start", start(read, "kubectl delete pods --all", "process-2"))).toThrow();
  });

  it("rejects credential paths and symlink escapes including destinations that do not exist", () => {
    const { policy, root, read, write, denied } = fixture();
    fs.symlinkSync(root, path.join(write, "escape"));
    fs.symlinkSync(denied, path.join(read, "alias"));
    fs.symlinkSync(path.join(root, "missing"), path.join(write, "dangling"));
    fs.mkdirSync(path.join(write, "real"));
    fs.symlinkSync(path.join(write, "real"), path.join(write, "internal-link"));
    expect(() => policy.authorize("fs/readFile", { path: uri(path.join(denied, "key")) })).toThrow(/grant/);
    expect(() => policy.authorize("fs/readFile", { path: uri(path.join(read, "alias", "key")) })).toThrow(/grant/);
    expect(() => policy.authorize("fs/writeFile", { path: uri(path.join(write, "escape", "new")) })).toThrow(/grant/);
    expect(() => policy.authorize("fs/writeFile", { path: uri(path.join(write, "dangling", "new")) })).toThrow();
    expect(() => policy.authorize("fs/writeFile", { path: uri(path.join(read, "new")) })).toThrow(/grant/);
    expect(() => policy.authorize("fs/writeFile", { path: uri(path.join(write, "internal-link", "new")) })).toThrow(/writable/);
    expect(() => policy.authorize("fs/remove", { path: uri(write), recursive: true })).toThrow(/removal/);
    expect(policy.authorize("fs/writeFile", { path: uri(path.join(write, "new")) }).params.path)
      .toBe(uri(path.join(fs.realpathSync(write), "new")));
  });

  it("scopes native continuation to the owning session and denies interactive command injection", () => {
    const { policy, read } = fixture();
    policy.authorize("process/start", start(read, "kubectl version --client"));
    expect(() => fixture().policy.authorize("process/terminate", { processId: "process-1" })).toThrow(/session/);
    expect(policy.authorize("process/write", { processId: "process-1", chunk: "" }).params.chunk).toBe("");
    expect(() => policy.authorize("process/write", { processId: "process-1", chunk: "ZXZpbA==" })).toThrow(/input/);
    policy.releaseProcess("process-1");
    expect(() => policy.authorize("process/signal", { processId: "process-1", signal: "interrupt" })).toThrow(/session/);
  });

  it("fails closed for unsupported methods, file handles, authority changes and execution forms", () => {
    const { policy, read } = fixture();
    for (const method of ["fs/open", "fs/readBlock", "http/request", "process/unknown"]) {
      expect(() => policy.authorize(method, {})).toThrow(/not authorized/);
    }
    expect(() => policy.authorize("process/start", { ...start(read, "kubectl version --client"), tty: true })).toThrow(/Interactive/);
    expect(() => policy.authorize("process/start", { ...start(read, "kubectl version --client"), argv: ["/bin/bash"] })).toThrow(/form/);
    expect(() => policy.authorize("fs/readFile", { path: "https://example.test/key" })).toThrow(/local/);
  });
});
