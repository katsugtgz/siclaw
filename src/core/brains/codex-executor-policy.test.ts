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
  it("reads only a selected Skill link without opening private native home", () => {
    const { root, read, write, denied } = fixture();
    const home = path.join(write, "private-native-home"), target = path.join(read, "selected-skill");
    fs.mkdirSync(path.join(home, "skills"), { recursive: true }); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "SKILL.md"), "Selected instructions");
    const alias = path.join(home, "skills", "selected"); fs.symlinkSync(target, alias);
    const policy = new CodexExecutorPolicy({ readRoots: [read], writeRoots: [write], deniedRoots: [denied, home],
      executionRoots: [write], allowCommands: false, allowFileCommands: true, production: false,
      skillReadAliases: [{ alias, target }] });
    expect(policy.authorize("fs/readFile", { path: uri(path.join(alias, "SKILL.md")) }).params.path).toBe(uri(fs.realpathSync(path.join(target, "SKILL.md"))));
    expect(policy.authorize("process/start", start(write, `cat ${path.join(alias, "SKILL.md")}`)).params.argv)
      .toEqual(["/bin/bash", "-c", `'cat' '${fs.realpathSync(path.join(target, "SKILL.md"))}'`]);
    for (const location of [home, path.join(home, "config.toml"), path.join(home, "skills"), path.join(home, "auth.json")]) {
      expect(() => policy.authorize("fs/readFile", { path: uri(location) })).toThrow();
    }
    expect(() => policy.authorize("fs/writeFile", { path: uri(path.join(alias, "SKILL.md")) })).toThrow();
    fs.symlinkSync(denied, path.join(target, "escape"));
    expect(() => policy.authorize("fs/readFile", { path: uri(path.join(alias, "escape", "key")) })).toThrow();
    fs.unlinkSync(alias); fs.symlinkSync(read, alias);
    expect(() => policy.authorize("fs/readFile", { path: uri(path.join(alias, "selected-skill", "SKILL.md")) })).toThrow();
  });
  it("selected Skill aliases cannot create canonical read authority or override credential denies", () => {
    const { root, read, write, denied } = fixture();
    const home = path.join(write, "private"), alias = path.join(home, "selected"); fs.mkdirSync(home);
    fs.symlinkSync(denied, alias); fs.writeFileSync(path.join(denied, "key"), "synthetic");
    const policy = new CodexExecutorPolicy({ readRoots: [read], writeRoots: [write], deniedRoots: [home, denied],
      allowCommands: false, production: false, skillReadAliases: [{ alias, target: denied }] });
    expect(() => policy.authorize("fs/readFile", { path: uri(path.join(alias, "key")) })).toThrow();
    const isolated = new CodexExecutorPolicy({ readRoots: [], writeRoots: [], deniedRoots: [home],
      allowCommands: false, production: false, skillReadAliases: [{ alias, target: denied }] });
    expect(() => isolated.authorize("fs/readFile", { path: uri(path.join(alias, "key")) })).toThrow();
  });
  it("allows only this session's immutable input mount when general file tools are disabled", () => {
    const { root, read } = fixture();
    const inputs = path.join(root, "inputs"), own = path.join(inputs, "own"), other = path.join(inputs, "other");
    fs.mkdirSync(inputs); fs.mkdirSync(own); fs.mkdirSync(other);
    fs.writeFileSync(path.join(own, "log.txt"), "safe evidence");
    fs.symlinkSync(read, path.join(own, "escape"));
    const policy = new CodexExecutorPolicy({ readRoots: [], writeRoots: [], deniedRoots: [inputs],
      inputRoots: [own], executionRoots: [read], allowCommands: false, allowFileCommands: false, production: false });
    expect(policy.authorize("fs/canonicalize", { path: uri(read) }).params.path).toBe(uri(fs.realpathSync(read)));
    expect(() => policy.authorize("fs/readDirectory", { path: uri(read) })).toThrow();
    expect(policy.authorize("process/start", start(read, `cat ${path.join(own, "log.txt")}`)).params).toBeDefined();
    expect(() => policy.authorize("fs/readFile", { path: uri(path.join(other, "log.txt")) })).toThrow();
    expect(() => policy.authorize("fs/readFile", { path: uri(path.join(own, "escape", "key")) })).toThrow();
    expect(() => policy.authorize("fs/writeFile", { path: uri(path.join(own, "log.txt")) })).toThrow();
    expect(() => policy.authorize("process/start", start(read, `cat ${path.join(read, "x")}`, "another"))).toThrow();
  });
  it("refuses shell environment overrides of broker identity before native process execution", () => {
    const { policy, read } = fixture();
    for (const cmd of ["KUBECONFIG=/tmp/other kubectl get pods", "PATH=/tmp kubectl get pods", "echo ok; KUBECONFIG=/tmp/x kubectl get pods"]) {
      expect(() => policy.authorize("process/start", start(read, cmd))).toThrow(/environment overrides/);
    }
  });
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

  it("authorizes native file argv by scope and refuses shell injection, links and unsafe search options", () => {
    const { policy, read, denied } = fixture();
    const file = path.join(read, "notes.md");
    fs.writeFileSync(file, "safe");
    const allowed = policy.authorize("process/start", start(read, "cat notes.md"));
    expect(allowed.params.argv).toEqual(["/bin/bash", "-c", `'cat' '${fs.realpathSync(file)}'`]);
    expect(allowed.command?.security.hasSensitiveKubectl).toBe(false);
    fs.symlinkSync(denied, path.join(read, "alias"));
    for (const command of ["cat /etc/passwd", "cat alias/key", "cat notes.md; touch owned", "cat $(id)",
      "rg --pre sh pattern notes.md", "rg -L pattern .", "rg --files .", "head -n nope notes.md"]) {
      expect(() => policy.authorize("process/start", start(read, command, command))).toThrow();
    }
    expect(policy.authorize("process/start", start(read, "rg -n '$(touch owned)' notes.md", "search"))
      .params.argv).toEqual(["/bin/bash", "-c", `'rg' '-n' '$(touch owned)' '${fs.realpathSync(file)}'`]);
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

  it("does not turn shell permission or a command cwd into a file-read grant", () => {
    const { read } = fixture();
    const policy = new CodexExecutorPolicy({readRoots:[],writeRoots:[],deniedRoots:[],executionRoots:[read],
      allowCommands:true,allowFileCommands:false,production:false});
    expect(policy.authorize("process/start",start(read,"kubectl version --client")).params.cwd).toBe(uri(fs.realpathSync(read)));
    expect(() => policy.authorize("fs/readFile",{path:uri(path.join(read,"notes.md"))})).toThrow(/grant/);
    expect(() => policy.authorize("process/start",start(read,"cat notes.md","read"))).toThrow();
  });
});
