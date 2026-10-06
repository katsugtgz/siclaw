import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillScriptResolver } from "../../tools/infra/script-resolver.js";
import { createNativeSkillScriptGrants, authorizeSkillScriptCommand, revalidateSkillScript } from "./codex-skill-scripts.js";
import { authorizeInfrastructureCommand, executeInfrastructureOperation } from "./codex-infrastructure.js";
import { CodexExecutorPolicy } from "./codex-executor-policy.js";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-skill-test-")));roots.push(root);
  const base = path.join(root, "skills"), loaded = path.join(base, "resolved"), skill = path.join(loaded, "inspect");
  fs.mkdirSync(path.join(skill, "scripts"), { recursive: true });fs.mkdirSync(path.join(root, "workspace"));
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: inspect\ndescription: Diagnostic fixture\n---\nUse read.sh\n");
  const file = path.join(skill, "scripts", "read.sh");
  fs.writeFileSync(file, "#!/bin/bash\nprintf 'NATIVE_SKILL_OK:%s\\n' \"$1\"\nprintf 'password: native-fixture-secret\\n'\n");
  const resolver = createSkillScriptResolver({ skillsBaseDir: base, resolvedSkillsDir: loaded, builtinDirs: [] });
  const grants = createNativeSkillScriptGrants([{ name: "inspect", filePath: path.join(skill, "SKILL.md") }], resolver,
    { local: true, pod: true, node: true, host: true });
  return { root, skill, file, resolver, grants, cwd: path.join(root, "workspace") };
}
describe("native Skill assets at the execution boundary", () => {
  it("executes only selected asset bytes with literal arguments and sanitized output", async () => {
    const { file, grants, cwd } = fixture();
    const script = authorizeSkillScriptCommand(`bash ${file} 'hello; touch /tmp/NO'`, cwd, "local", grants)!;
    expect(script.args).toEqual(["hello; touch /tmp/NO"]);
    const result = await executeInfrastructureOperation(undefined, { kind: "local-script", command: "approved", script,
      security: { error: null, action: null, hasSensitiveKubectl: false } }, new AbortController().signal, grants, { PATH: process.env.PATH });
    expect(result.exitCode).toBe(0);expect(result.stdout).toContain("NATIVE_SKILL_OK:hello; touch /tmp/NO");
    expect(result.stdout).not.toContain("native-fixture-secret");
  });
  it("keeps package-relative helpers available in the private local snapshot", async () => {
    const { skill, file, resolver, cwd } = fixture();
    fs.writeFileSync(path.join(skill, "scripts", "helper.sh"), "echo PACKAGE_HELPER_OK\n");
    fs.writeFileSync(file, 'source "$(dirname "$0")/helper.sh"\n');
    const grants = createNativeSkillScriptGrants([{ name: "inspect", filePath: path.join(skill, "SKILL.md") }], resolver,
      { local: true, pod: false, node: false, host: false });
    const script = authorizeSkillScriptCommand(`bash ${file}`, cwd, "local", grants)!;
    const result = await executeInfrastructureOperation(undefined, { kind: "local-script", command: "approved", script,
      security: { error: null, action: null, hasSensitiveKubectl: false } }, new AbortController().signal, grants, { PATH: process.env.PATH });
    expect(result.stdout).toContain("PACKAGE_HELPER_OK");
  });
  it("rejects inline interpreters, unbound scripts, chaining and incorrect interpreter types", () => {
    const { file, grants, cwd } = fixture();
    for (const command of [`bash ${file}; touch /tmp/NO`, `bash ${file} > /tmp/NO`, `python3 ${file}`, "bash /tmp/unreviewed.sh",
      `bash ${file} $(touch /tmp/NO)`, `timeout 301 bash ${file}`]) {
      expect(() => authorizeSkillScriptCommand(command, cwd, "local", grants)).toThrow();
    }
    expect(authorizeSkillScriptCommand("bash -c 'touch /tmp/NO'", cwd, "local", grants)).toBeUndefined();
  });
  it("rechecks asset hash, resolver precedence and disabled builtin policy before launch", () => {
    const { file, grants, cwd, resolver } = fixture();
    const script = authorizeSkillScriptCommand(`bash ${file}`, cwd, "local", grants)!;
    fs.writeFileSync(file, "echo replaced");expect(() => revalidateSkillScript(script, grants)).toThrow(/changed/);
    vi.spyOn(resolver, "resolveScript").mockReturnValue({ error: "disabled" });
    expect(() => revalidateSkillScript(script, grants)).toThrow(/changed/);
  });
  it("rejects a changed sibling helper even when the main script is unchanged", () => {
    const { skill, file, grants, cwd } = fixture();
    const script = authorizeSkillScriptCommand(`bash ${file}`, cwd, "local", grants)!;
    fs.writeFileSync(path.join(skill, "scripts", "helper.sh"), "echo replaced-helper\n");
    expect(() => revalidateSkillScript(script, grants)).toThrow(/changed/);
  });
  it("refuses symlink script escapes and same-name assets outside the loaded scope", () => {
    const { root, skill, file, resolver, cwd } = fixture();fs.rmSync(file);
    const outside = path.join(root, "outside.sh");fs.writeFileSync(outside, "echo unreviewed");fs.symlinkSync(outside, file);
    const grants = createNativeSkillScriptGrants([{ name: "inspect", filePath: path.join(skill, "SKILL.md") }], resolver,
      { local: true, pod: true, node: true, host: true });
    expect(grants.assets).toHaveLength(0);
    expect(() => authorizeSkillScriptCommand(`bash ${file}`, cwd, "local", grants)).toThrow(/loaded Skills/);
  });
  it("separates script capabilities from ordinary commands on all three remote targets", () => {
    const { file, grants, cwd } = fixture();
    const cluster = { kind: "cluster" as const, name: "bound", broker: {} as any, userId: "user", allowApi: false, allowPod: false, allowNode: false };
    const host = { kind: "ssh" as const, broker: {} as any, allowCommands: false };
    for (const command of [`kubectl exec pod-a -- bash ${file}`, `kubectl debug node/node-a -- bash ${file}`]) {
      expect(authorizeInfrastructureCommand(command, cluster, grants, cwd)?.script?.path).toBe(file);
    }
    expect(authorizeInfrastructureCommand(`ssh host-a -- bash ${file}`, host, grants, cwd)?.script?.path).toBe(file);
    for (const command of ["kubectl get pods", "kubectl exec pod-a -- uname", "kubectl debug node/node-a -- uname"]) {
      expect(() => authorizeInfrastructureCommand(command, cluster, grants, cwd)).toThrow();
    }
    expect(() => authorizeInfrastructureCommand("ssh host-a -- uname", host, grants, cwd)).toThrow();
    expect(() => authorizeInfrastructureCommand(`ssh host-a -- bash ${file}`, host,
      { ...grants, allowed: { ...grants.allowed, host: false } }, cwd)).toThrow(/not authorized/);
  });
  it("authorizes an exec-server script operation without permitting general shell or stdin", () => {
    const { file, grants, cwd } = fixture();
    const policy = new CodexExecutorPolicy({ readRoots: [], executionRoots: [cwd], writeRoots: [], deniedRoots: [],
      allowCommands: false, allowFileCommands: false, production: false, skillScripts: grants });
    const start = (command: string, id: string) => ({ processId: id, argv: ["/bin/bash", "-c", command], cwd: pathToFileURL(cwd).href });
    expect(policy.authorize("process/start", start(`timeout 240 bash ${file}`, "script")).infrastructure?.script?.timeoutSeconds).toBe(240);
    expect(() => policy.authorize("process/start", start("bash -c id", "inline"))).toThrow();
    expect(() => policy.authorize("process/write", { processId: "script", chunk: "ZXZpbA==" })).toThrow(/input/);
  });
});
