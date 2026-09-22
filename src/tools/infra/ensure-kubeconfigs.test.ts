import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ensureClusterForTool,
  ensureHostForTool,
  classifyClusterFailure,
  ensureDevopsCredentialForTool,
  DEVOPS_CLI_BINARY,
} from "./ensure-kubeconfigs.js";
import { setExtraCommands } from "./command-sets.js";

describe("ensureClusterForTool", () => {
  it("no-op when broker undefined", async () => {
    await expect(ensureClusterForTool(undefined, "x", "p")).resolves.toBeUndefined();
  });

  it("calls ensureCluster for specific name", async () => {
    const calls: string[] = [];
    const broker = {
      ensureCluster: async (n: string) => { calls.push(n); },
      refreshClusters: async () => [],
    } as any;
    await ensureClusterForTool(broker, "prod", "p");
    expect(calls).toEqual(["prod"]);
  });

  it("auto-selects single cluster when no name given", async () => {
    const calls: string[] = [];
    const broker = {
      ensureCluster: async (n: string) => { calls.push(n); },
      refreshClusters: async () => [{ name: "only-one" }],
    } as any;
    await ensureClusterForTool(broker, undefined, "p");
    expect(calls).toEqual(["only-one"]);
  });

  it("does NOT ensure any cluster when multiple bound and no name given", async () => {
    const calls: string[] = [];
    const broker = {
      ensureCluster: async (n: string) => { calls.push(n); },
      refreshClusters: async () => [{ name: "a" }, { name: "b" }],
    } as any;
    await ensureClusterForTool(broker, undefined, "p");
    expect(calls).toEqual([]);
  });
});

describe("ensureHostForTool", () => {
  it("throws when broker missing", async () => {
    await expect(ensureHostForTool(undefined, "h1", "p")).rejects.toThrow("Credential broker required");
  });

  it("calls broker.ensureHost", async () => {
    const calls: string[] = [];
    const broker = { ensureHost: async (n: string) => { calls.push(n); } } as any;
    await ensureHostForTool(broker, "h1", "p");
    expect(calls).toEqual(["h1"]);
  });

  it("propagates ensureHost errors", async () => {
    const broker = { ensureHost: async () => { throw new Error("not bound"); } } as any;
    await expect(ensureHostForTool(broker, "h1", "p")).rejects.toThrow("not bound");
  });
});

describe("classifyClusterFailure", () => {
  // The transport reports a missing binding as an HTTP 502 "cluster not found",
  // which is indistinguishable from a real upstream fault — the binding list is
  // what tells them apart.
  const gatewayError = new Error('Gateway returned 502: {"error":"cluster not found"}');

  it("reports an unbound cluster as a non-retryable config error", async () => {
    const broker = {
      refreshClusters: async () => [{ name: "prod" }, { name: "staging" }],
    } as any;
    const result = await classifyClusterFailure(broker, "typo-cluster", gatewayError);
    expect(result.reason).toBe("cluster_not_bound");
    expect(result.retryable).toBe(false);
    expect(result.available_clusters).toEqual(["prod", "staging"]);
    expect(result.message).toContain("cluster_list");
    // The 502 must not survive — it is what misleads the caller into retrying.
    expect(result.message).not.toContain("502");
  });

  it("says so explicitly when nothing at all is bound", async () => {
    const broker = { refreshClusters: async () => [] } as any;
    const result = await classifyClusterFailure(broker, "prod", gatewayError);
    expect(result.reason).toBe("cluster_not_bound");
    expect(result.available_clusters).toEqual([]);
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("No cluster is bound");
  });

  // ensureClusterForTool auto-selects when the caller omits `cluster`, so this
  // path arrives with no name — but an empty list is just as conclusive.
  it("reports not-bound for an empty list even with no name given", async () => {
    const broker = { refreshClusters: async () => [] } as any;
    const result = await classifyClusterFailure(broker, undefined, gatewayError);
    expect(result.reason).toBe("cluster_not_bound");
    expect(result.retryable).toBe(false);
    expect(result.message).not.toContain("502");
  });

  it("keeps the upstream error when the cluster IS bound", async () => {
    const broker = { refreshClusters: async () => [{ name: "prod" }] } as any;
    const result = await classifyClusterFailure(broker, "prod", new Error("TLS handshake timeout"));
    expect(result.reason).toBe("cluster_unavailable");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("TLS handshake timeout");
    expect(result.available_clusters).toEqual(["prod"]);
  });

  it("does not claim 'not bound' when the binding list itself is unreachable", async () => {
    const broker = {
      refreshClusters: async () => { throw new Error("list failed"); },
    } as any;
    const result = await classifyClusterFailure(broker, "prod", gatewayError);
    expect(result.reason).toBe("cluster_unavailable");
    expect(result.retryable).toBe(true);
    expect(result.message).toContain("502");
  });

  it("falls back to cluster_unavailable with no broker", async () => {
    const result = await classifyClusterFailure(undefined, "prod", gatewayError);
    expect(result.reason).toBe("cluster_unavailable");
    expect(result.available_clusters).toEqual([]);
  });

  it("does not label an auto-select failure as unbound (no name given)", async () => {
    const broker = { refreshClusters: async () => [{ name: "prod" }] } as any;
    const result = await classifyClusterFailure(broker, undefined, gatewayError);
    expect(result.reason).toBe("cluster_unavailable");
  });
});

describe("every tool that ensures a cluster also classifies the failure", () => {
  it("has no caller that lets a raw ensure error through", async () => {
    // Sibling of the json_path wiring invariant, and the same failure mode: a helper wired at six call
    // sites with behavioural tests at two of them. A seventh tool added later that calls
    // `ensureClusterForTool` without classifying reports "cluster unavailable" for a cluster that is
    // simply not bound — the misdiagnosis this pair of functions exists to prevent.
    const { readFileSync, globSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const files = globSync("src/tools/**/*.ts", { cwd: resolve(import.meta.dirname, "../../..") })
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith("ensure-kubeconfigs.ts"));

    const callers: string[] = [];
    for (const f of files) {
      const src = readFileSync(resolve(import.meta.dirname, "../../..", f), "utf8");
      // Strip block and line comments: kubeconfig-resolver.ts names the function in its header only,
      // and counting that would demand classification from a file that never calls it.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/\bensureClusterForTool\s*\(/.test(code)) callers.push(f);
    }
    expect(callers.length, "expected the exec tools to be found").toBeGreaterThanOrEqual(6);

    for (const f of callers) {
      const src = readFileSync(resolve(import.meta.dirname, "../../..", f), "utf8");
      expect(src, `${f} ensures a cluster but never calls classifyClusterFailure — an unbound cluster `
        + `would be reported as unavailable`).toMatch(/\bclassifyClusterFailure\s*\(/);
    }
  });
});

describe("ensureDevopsCredentialForTool", () => {
  function fakeBroker() {
    const calls: string[] = [];
    return {
      calls,
      broker: { ensureDevopsCredential: async (p: string) => { calls.push(p); } } as any,
    };
  }

  it("no-op when broker undefined", async () => {
    await expect(ensureDevopsCredentialForTool(undefined, [DEVOPS_CLI_BINARY], "p")).resolves.toBeUndefined();
  });

  it("fetches when the command set contains the CLI", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(broker, ["jq", DEVOPS_CLI_BINARY], "restricted_bash");
    expect(calls).toEqual(["restricted_bash"]);
  });

  it("does nothing for a command set that does not contain it", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(broker, ["kubectl", "grep", "jq"], "restricted_bash");
    expect(calls).toEqual([]);
  });

  // Exact name only. A prefix or substring match would fetch a delivery credential
  // for any binary whose name happens to start the same way.
  it("does not match on a name that merely looks like it", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(broker, ["siforgectl-shim", "notsiforgectl"], "p");
    expect(calls).toEqual([]);
  });

  it("propagates the failure rather than letting the CLI run without a credential", async () => {
    const broker = {
      ensureDevopsCredential: async () => { throw new Error("no delivery-platform credential"); },
    } as any;
    await expect(ensureDevopsCredentialForTool(broker, [DEVOPS_CLI_BINARY], "p"))
      .rejects.toThrow(/no delivery-platform credential/);
  });
});

// The declaration-driven half: a subcommand its command declared as needing no
// credential must not arm the prefetch, and everything else still must.
//
// 🔴 The bug these pin is not "describe was blocked". It is that the ONE command
// which explains what the binary can do was the one command a box with broken
// provisioning could not run, so the model reported the whole CLI unusable
// instead of "I can read the contract but cannot act yet".
describe("ensureDevopsCredentialForTool — credential-free subcommands", () => {
  function fakeBroker() {
    const calls: string[] = [];
    return {
      calls,
      broker: { ensureDevopsCredential: async (p: string) => { calls.push(p); } } as any,
    };
  }

  beforeEach(() => {
    setExtraCommands({
      [DEVOPS_CLI_BINARY]: {
        category: "general",
        allowedSubcommands: { position: 0, allowed: ["describe", "deploy", "build"] },
        credentialFreeSubcommands: { position: 0, subcommands: ["describe"] },
      },
    });
  });
  afterEach(() => { setExtraCommands({}); });

  it("does not fetch for a declared credential-free subcommand", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(broker, [`${DEVOPS_CLI_BINARY} describe`], "restricted_bash");
    expect(calls).toEqual([]);
  });

  // The subcommand is the Nth POSITIONAL, not argv[1] — the same walk the
  // whitelist uses. A global flag in front must not turn a free read into a fetch.
  it("skips leading flags when locating the subcommand", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(broker, [`${DEVOPS_CLI_BINARY} --pretty describe`], "p");
    expect(calls).toEqual([]);
  });

  it("still fetches for a subcommand that reaches the platform", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(broker, [`${DEVOPS_CLI_BINARY} deploy run --yes`], "restricted_bash");
    expect(calls).toEqual(["restricted_bash"]);
  });

  // A pipeline is armed by ANY invocation that needs the credential. The cheap
  // read must not decide for the expensive write standing next to it.
  it("fetches when a pipeline mixes a free read with a real call", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(
      broker,
      [`${DEVOPS_CLI_BINARY} describe`, "jq .", `${DEVOPS_CLI_BINARY} build list`],
      "p",
    );
    expect(calls).toEqual(["p"]);
  });

  // Fail-closed: an undeclared subcommand is not free just because a sibling is.
  it("fetches for a subcommand the declaration does not name", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(broker, [`${DEVOPS_CLI_BINARY} build list`], "p");
    expect(calls).toEqual(["p"]);
  });

  // …and a bare binary names no subcommand at all, so it cannot be the free one.
  it("fetches when no subcommand is present", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(broker, [DEVOPS_CLI_BINARY], "p");
    expect(calls).toEqual(["p"]);
  });

  it("resolves the declaration through an absolute path, as the whitelist does", async () => {
    const { calls, broker } = fakeBroker();
    await ensureDevopsCredentialForTool(broker, [`/usr/local/bin/${DEVOPS_CLI_BINARY} describe`], "p");
    expect(calls).toEqual([]);
  });
});

// Without a declaration nothing changes — this is the state every other
// deployment is in, and the one that must keep prefetching.
describe("ensureDevopsCredentialForTool — no declaration", () => {
  afterEach(() => { setExtraCommands({}); });

  it("fetches for every subcommand when the command declares none", async () => {
    setExtraCommands({
      [DEVOPS_CLI_BINARY]: { category: "general", allowedSubcommands: { position: 0, allowed: ["describe"] } },
    });
    const calls: string[] = [];
    const broker = { ensureDevopsCredential: async (p: string) => { calls.push(p); } } as any;
    await ensureDevopsCredentialForTool(broker, [`${DEVOPS_CLI_BINARY} describe`], "p");
    expect(calls).toEqual(["p"]);
  });
});
