import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { COMMANDS, CONTAINER_SENSITIVE_PATHS, setExtraCommands, shellEscape } from "../../tools/infra/command-sets.js";
import { parseExtraCommandsConfig } from "../../tools/infra/extra-commands.js";
import { preExecSecurity } from "../../tools/infra/security-pipeline.js";
import { authorizeInfrastructureCommand, type CodexInfrastructureTarget } from "./codex-infrastructure.js";

const contexts = ["pod", "node", "host"] as const;
type Context = typeof contexts[number];
const legacyBroker = {getChannelPolicy:()=>undefined,requireChannelOperation:()=>{}};
const cluster: CodexInfrastructureTarget = { kind: "cluster", name: "bound", broker: legacyBroker as any,
  userId: "user", allowApi: true, allowPod: true, allowNode: true };
const ssh: CodexInfrastructureTarget = { kind: "ssh", broker: legacyBroker as any };

// These options are the existing Pi pod_exec/node_exec/host_exec contract.
function piSecurity(command: string, context: Context) {
  return preExecSecurity(command, context === "pod"
    ? { context, sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS, blockPipeline: true }
    : { context, sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS, analyzeTarget: "last-in-pipeline" });
}
function nativeOperation(command: string, context: Context) {
  if (context === "host") return authorizeInfrastructureCommand(`ssh bound-host ${shellEscape(command)}`, ssh)!;
  const selector = context === "pod" ? "exec pod-a" : "debug node/node-a";
  return authorizeInfrastructureCommand(`kubectl ${selector} -- sh -c ${shellEscape(command)}`, cluster)!;
}
function expectParity(command: string, context: Context) {
  const pi = piSecurity(command, context);
  if (pi.error) {
    expect(() => nativeOperation(command, context)).toThrow(pi.error);
  } else {
    const native = nativeOperation(command, context).security;
    expect({ ...native, action: native.action && { type: native.action.type, lineSafe: native.action.lineSafe } })
      .toEqual({ ...pi, action: pi.action && { type: pi.action.type, lineSafe: pi.action.lineSafe } });
    // Some output rules create a new closure on each analysis. Compare its
    // behavior instead of function identity, including sensitive env output.
    const output = "HOME=/home/reader\nOPENAI_API_KEY=parity-fixture-secret\n";
    expect(native.action?.sanitize(output)).toEqual(pi.action?.sanitize(output));
    if (["env", "printenv"].includes(command)) expect(native.action?.sanitize(output)).not.toContain("parity-fixture-secret");
  }
}

afterEach(() => setExtraCommands({}));

describe.each(contexts)("Pi/Codex shared %s whitelist", context => {
  // This catches a second engine-specific allow-list when commands are added
  // to the shared registry, including commands with required flags/subcommands.
  it.each(Object.keys(COMMANDS).sort())("matches the shared builtin definition for %s", command => {
    expectParity(command, context);
  });
  it.each([
    "curl -sS https://example.test/healthz", "curl -X POST https://example.test", "curl -o /tmp/result https://example.test",
    "ping -c 1 192.0.2.1", "tcpdump -c 1 -i eth0", "tcpdump -w /tmp/capture", "lsof -n", "lsns",
    "zgrep error /var/log/app.gz", "getent hosts example.test", "resolvectl status", "ibportstate 1 1 query",
    "ib_write_bw -d mlx5_0 --report_gbits", "ib_write_bw --output=/tmp/result",
    "sysctl vm.swappiness", "sysctl -w vm.swappiness=0", "ip addr show", "ip link set eth0 down",
    "systemctl status ssh", "systemctl restart ssh", "nvidia-smi --query-gpu=name --format=csv", "nvidia-smi --gpu-reset",
    "env", "printenv", "env sh -c id", "cat /etc/os-release", "cat /etc/shadow", "cat /proc/1/environ",
    "find /var/log -name '*.log'", "find /tmp -delete", "sort -o /tmp/result /var/log/app.log",
    "uname -a | grep Linux", "uname -a; hostname", "uname -a | touch /tmp/result", "echo ok > /tmp/result",
    "cat /etc/os-release | awk '{print}'", "cat $(id)", "unknown-vendor-command", "tee /tmp/result",
  ])("matches Pi admission and output policy for %s", command => {
    expectParity(command, context);
  });
  it("applies deployed extra commands, constraints and removal without another engine list", () => {
    const file = new URL("../../../docker/extra-commands.json", import.meta.url);
    setExtraCommands(parseExtraCommandsConfig(readFileSync(file, "utf8"), file.pathname));
    for (const command of ["sichek gpu", "sichek all", "sichek daemon", "sichek ibtest", "mmlscluster --ces",
      "/usr/lpp/mmfs/bin/mmlscluster --ces",
      "mmlscluster unexpected", "mmchcluster -p node-a"]) expectParity(command, context);
    expect(nativeOperation("sichek gpu", context).security.error).toBeNull();
    const direct = context === "host" ? "ssh bound-host -- /usr/lpp/mmfs/bin/mmlscluster --ces"
      : `kubectl ${context === "pod" ? "exec pod-a" : "debug node/node-a"} -- /usr/lpp/mmfs/bin/mmlscluster --ces`;
    expect(authorizeInfrastructureCommand(direct, context === "host" ? ssh : cluster)?.security.error).toBeNull();
    for (const path of ["/tmp/mmlscluster", "/opt/unreviewed/mmlscluster", "/usr/lpp/mmfs/bin/../bin/mmlscluster"]) {
      expect(() => nativeOperation(`${path} --ces`, context)).toThrow();
    }
    setExtraCommands({});
    expect(() => nativeOperation("sichek gpu", context)).toThrow(/not in the allowed command list/);
    expect(() => nativeOperation("/usr/lpp/mmfs/bin/mmlscluster --ces", context)).toThrow();
  });
  it("accepts configured binary names with dots and enforces additive-only rules", () => {
    const extras = parseExtraCommandsConfig(JSON.stringify({ version: 1, commands: {
      "vendor.inspect": { category: "diagnostic", allowedFlags: ["--show"] },
      sysctl: { category: "kernel" },
    } }), "parity.json");
    expect(setExtraCommands(extras).skipped).toEqual(["sysctl"]);
    for (const command of ["vendor.inspect --show", "vendor.inspect --reset", "sysctl -w vm.swappiness=0"]) {
      expectParity(command, context);
    }
    expect(nativeOperation("vendor.inspect --show", context).security.error).toBeNull();
    const direct = context === "host" ? "ssh bound-host -- vendor.inspect --show"
      : `kubectl ${context === "pod" ? "exec pod-a" : "debug node/node-a"} -- vendor.inspect --show`;
    expect(authorizeInfrastructureCommand(direct, context === "host" ? ssh : cluster)?.security.error).toBeNull();
  });
});
