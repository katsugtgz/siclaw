import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexExecutorPolicy } from "./codex-executor-policy.js";
import { executeInfrastructureOperation, type InfrastructureOperation } from "./codex-infrastructure.js";
import { ensureDevopsCredentialForTool } from "../../tools/infra/ensure-kubeconfigs.js";
import { extractCommands } from "../../tools/infra/command-validator.js";
import { setExtraCommands } from "../../tools/infra/command-sets.js";
import type { CredentialBroker } from "../../agentbox/credential-broker.js";

const { spawnNativeStream } = vi.hoisted(() => ({ spawnNativeStream: vi.fn().mockResolvedValue(0) }));
vi.mock("./codex-process-stream.js", async original => ({ ...await original<object>(), spawnNativeStream }));

describe("native command preparation before launch", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "native-cli-preparation-"));
    vi.clearAllMocks();
    setExtraCommands({ siforgectl: { category: "general", contexts: ["local"],
      allowedSubcommands: { position: 0, allowed: ["describe", "delivery"] },
      credentialFreeSubcommands: { position: 0, subcommands: ["describe"] } } });
  });
  afterEach(() => { setExtraCommands({}); fs.rmSync(root, { recursive: true, force: true }); });
  const operation = (command: string): InfrastructureOperation => {
    const policy = new CodexExecutorPolicy({ readRoots: [root], writeRoots: [], deniedRoots: [], allowCommands: true,
      production: false, environment: { PATH: process.env.PATH ?? "" } });
    const authorized = policy.authorize("process/start", { processId: "process", argv: ["/bin/bash", "-c", command],
      cwd: pathToFileURL(root).href });
    return { kind: "local-command", command: authorized.command!.text, security: authorized.command!.security,
      cwd: String(authorized.params.cwd), environment: authorized.params.env as Record<string, string>, production: false };
  };
  it("uses the existing context whitelist and keeps credential-free discovery usable", async () => {
    const ensure = vi.fn();
    const broker = { ensureDevopsCredential: ensure, getDevopsCredentialPath: () => path.join(root, "bound-delivery.json") } as unknown as CredentialBroker;
    for (const command of ["siforgectl describe", "siforgectl delivery inventory"]) {
      await executeInfrastructureOperation(undefined, operation(command), new AbortController().signal,
        undefined, undefined, undefined, undefined, undefined,
        async (validated, signal) => {
          const environment = await ensureDevopsCredentialForTool(broker, extractCommands(validated), "native-executor");
          signal.throwIfAborted(); return environment;
        });
    }
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(spawnNativeStream).toHaveBeenCalledTimes(2);
    expect(spawnNativeStream.mock.calls[1][2].env.SIFORGECTL_CREDENTIAL_FILE).toBe(path.join(root, "bound-delivery.json"));
    expect(() => operation("siforgectl deploy" )).toThrow();
    expect(() => operation("SIFORGECTL_CREDENTIAL_FILE=/other/grant siforgectl delivery inventory")).toThrow();
  });
  it("does not launch when credential preparation fails", async () => {
    const prepare = vi.fn().mockRejectedValue(new Error("delivery credential denied"));
    await expect(executeInfrastructureOperation(undefined, operation("siforgectl delivery inventory"), new AbortController().signal,
      undefined, undefined, undefined, undefined, undefined, prepare)).rejects.toThrow(/credential denied/);
    expect(spawnNativeStream).not.toHaveBeenCalled();
  });
  it("does not launch when Stop arrives during asynchronous preparation", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const preparing = new Promise<void>(resolve => { release = resolve; });
    const result = executeInfrastructureOperation(undefined, operation("siforgectl delivery inventory"), controller.signal,
      undefined, undefined, undefined, undefined, undefined, async () => preparing);
    controller.abort(); release();
    await expect(result).rejects.toThrow();
    expect(spawnNativeStream).not.toHaveBeenCalled();
  });
});
