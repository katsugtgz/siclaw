import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseExtraCommandsConfig,
  loadExtraCommands,
  DEFAULT_EXTRA_COMMANDS_PATH,
} from "./extra-commands.js";
import {
  setExtraCommands,
  getContextAllowedSet,
  validateCommandRestrictions,
  isCredentialFreeInvocation,
} from "./command-sets.js";
import { validateCommand } from "./command-validator.js";

afterEach(() => {
  setExtraCommands({});
});

// ── parseExtraCommandsConfig (schema validation) ────────────────────

describe("parseExtraCommandsConfig", () => {
  const wrap = (commands: unknown) =>
    JSON.stringify({ version: 1, commands });

  it("accepts a maximal valid config", () => {
    const parsed = parseExtraCommandsConfig(wrap({
      iperf3: {
        category: "network",
        description: "site-specific throughput tool",
        allowedFlags: ["-c", "-p", "--json"],
      },
      mytool: {
        category: "hardware",
        blockedFlags: ["-w"],
        positionals: 2,
        requiredFlags: ["-b"],
      },
      vendorctl: {
        category: "services",
        allowedSubcommands: { position: 0, allowed: ["status", "show"] },
        positionals: "block",
      },
    }), "test.json");

    expect(Object.keys(parsed).sort()).toEqual(["iperf3", "mytool", "vendorctl"]);
    // description is CARRIED, not stripped: it is the only thing that tells a model the command
    // exists, and dropping it is what made two shipped entries invisible for months.
    expect(parsed.iperf3).toEqual({
      category: "network",
      description: "site-specific throughput tool",
      allowedFlags: ["-c", "-p", "--json"],
    });
    expect(parsed.mytool.positionals).toBe(2);
    expect(parsed.vendorctl.allowedSubcommands).toEqual({ position: 0, allowed: ["status", "show"] });
  });

  it("accepts a bare entry (category only)", () => {
    const parsed = parseExtraCommandsConfig(wrap({ iperf3: { category: "network" } }), "t");
    expect(parsed.iperf3).toEqual({ category: "network" });
  });

  it('accepts positionals "allow", "block", and 0', () => {
    const parsed = parseExtraCommandsConfig(wrap({
      a1: { category: "network", positionals: "allow" },
      b2: { category: "network", positionals: "block" },
      c3: { category: "network", positionals: 0 },
    }), "t");
    expect(parsed.c3.positionals).toBe(0);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseExtraCommandsConfig("{nope", "bad.json")).toThrow(/bad\.json/);
  });

  it("rejects a non-object root", () => {
    expect(() => parseExtraCommandsConfig("[]", "t")).toThrow(/object/i);
  });

  it("rejects a missing or wrong version", () => {
    expect(() => parseExtraCommandsConfig(JSON.stringify({ commands: {} }), "t")).toThrow(/version/i);
    expect(() => parseExtraCommandsConfig(JSON.stringify({ version: 2, commands: {} }), "t")).toThrow(/version/i);
  });

  it("rejects a missing commands object", () => {
    expect(() => parseExtraCommandsConfig(JSON.stringify({ version: 1 }), "t")).toThrow(/commands/i);
  });

  it("rejects invalid command names", () => {
    expect(() => parseExtraCommandsConfig(wrap({ "Bad": { category: "network" } }), "t")).toThrow(/name/i);
    expect(() => parseExtraCommandsConfig(wrap({ "a/b": { category: "network" } }), "t")).toThrow(/name/i);
    expect(() => parseExtraCommandsConfig(wrap({ "": { category: "network" } }), "t")).toThrow(/name/i);
  });

  it("rejects an unknown category", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "shiny" } }), "t")).toThrow(/category/i);
  });

  it("rejects a missing category", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: {} }), "t")).toThrow(/category/i);
  });

  it("rejects unknown keys, including validate", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", nope: 1 } }), "t")).toThrow(/nope/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", validate: "x" } }), "t")).toThrow(/validate/);
  });

  it("rejects flags that do not start with a dash", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedFlags: ["c"] } }), "t")).toThrow(/-/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", blockedFlags: [""] } }), "t")).toThrow(/-/);
  });

  it("rejects non-array flag fields", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedFlags: "-c" } }), "t")).toThrow(/allowedFlags/);
  });

  it("rejects invalid positionals values", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", positionals: "maybe" } }), "t")).toThrow(/positionals/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", positionals: -1 } }), "t")).toThrow(/positionals/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", positionals: 1.5 } }), "t")).toThrow(/positionals/);
  });

  it("rejects malformed allowedSubcommands", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedSubcommands: { position: -1, allowed: ["a"] } } }), "t")).toThrow(/allowedSubcommands/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedSubcommands: { position: 0, allowed: [] } } }), "t")).toThrow(/allowedSubcommands/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedSubcommands: { allowed: ["a"] } } }), "t")).toThrow(/allowedSubcommands/);
  });

  it("accepts credentialFreeSubcommands and carries it through", () => {
    const parsed = parseExtraCommandsConfig(wrap({
      vendorctl: {
        category: "general",
        allowedSubcommands: { position: 0, allowed: ["describe", "deploy"] },
        credentialFreeSubcommands: { position: 0, subcommands: ["describe"] },
      },
    }), "t");
    expect(parsed.vendorctl.credentialFreeSubcommands).toEqual({ position: 0, subcommands: ["describe"] });
  });

  it("rejects malformed credentialFreeSubcommands", () => {
    const bad = (v: unknown) => wrap({ x: { category: "network", credentialFreeSubcommands: v } });
    expect(() => parseExtraCommandsConfig(bad({ position: -1, subcommands: ["a"] }), "t")).toThrow(/credentialFreeSubcommands/);
    expect(() => parseExtraCommandsConfig(bad({ position: 0, subcommands: [] }), "t")).toThrow(/credentialFreeSubcommands/);
    expect(() => parseExtraCommandsConfig(bad({ subcommands: ["a"] }), "t")).toThrow(/credentialFreeSubcommands/);
    // `allowed` is the neighbouring field's key; naming it here is the likely typo.
    expect(() => parseExtraCommandsConfig(bad({ position: 0, allowed: ["a"] }), "t")).toThrow(/credentialFreeSubcommands/);
  });

  // A subcommand declared credential-free but not whitelisted fails at load
  // rather than at use. Left to run, it skips the prefetch and is then refused
  // by the whitelist anyway — a typo that presents as a credential fault.
  it("rejects a credential-free subcommand the whitelist does not permit", () => {
    expect(() => parseExtraCommandsConfig(wrap({
      x: {
        category: "network",
        allowedSubcommands: { position: 0, allowed: ["describe"] },
        credentialFreeSubcommands: { position: 0, subcommands: ["describ"] },
      },
    }), "t")).toThrow(/does not permit/);
  });

  // Different positions mean the two fields are talking about different tokens,
  // so neither constrains the other and the cross-check must not invent a link.
  it("does not cross-check when the two fields name different positions", () => {
    const parsed = parseExtraCommandsConfig(wrap({
      x: {
        category: "network",
        allowedSubcommands: { position: 0, allowed: ["describe"] },
        credentialFreeSubcommands: { position: 1, subcommands: ["anything"] },
      },
    }), "t");
    expect(parsed.x.credentialFreeSubcommands).toEqual({ position: 1, subcommands: ["anything"] });
  });
  it("accepts exact reviewed vendor paths without changing argument constraints", () => {
    const parsed = parseExtraCommandsConfig(wrap({ vendorctl: { category: "diagnostic",
      executablePaths: ["/opt/vendor/bin/vendorctl"], allowedFlags: ["--show"] } }), "paths.json");
    expect(parsed.vendorctl.executablePaths).toEqual(["/opt/vendor/bin/vendorctl"]);
    setExtraCommands(parsed);
    expect(validateCommand("/opt/vendor/bin/vendorctl --show", { context: "host" })).toBeNull();
    expect(validateCommand("/opt/vendor/bin/vendorctl --reset", { context: "host" })).not.toBeNull();
  });

  it.each([[], "not-an-array", [1], ["vendorctl"], ["/tmp/vendorctl"], ["/opt/vendor/bash"],
    ["/opt/vendor/../vendor/vendorctl"], ["/opt/vendor//vendorctl"], ["/opt/*/vendorctl"], ["/opt/vendor/$HOME/vendorctl"]])(
    "rejects unsafe vendor executablePaths: %j", executablePaths => {
      expect(() => parseExtraCommandsConfig(wrap({ vendorctl: { category: "diagnostic", executablePaths } }), "paths.json"))
        .toThrow(/executablePaths/);
    });

  it("rejects a non-object command entry", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: "network" }), "t")).toThrow(/object/i);
  });

  it("rejects intentionally excluded binaries (shells, interpreters, wrappers, exfil tools)", () => {
    for (const name of ["bash", "sh", "python3", "sed", "awk", "nc", "wget", "xargs", "timeout", "sudo", "nsenter", "ssh", "kubectl"]) {
      expect(() => parseExtraCommandsConfig(wrap({ [name]: { category: "general" } }), "t"))
        .toThrow(/cannot be whitelisted/i);
    }
  });

  it("rejects multi-call wrappers (busybox/toybox) that provide a shell", () => {
    for (const name of ["busybox", "toybox"]) {
      expect(() => parseExtraCommandsConfig(wrap({ [name]: { category: "general" } }), "t"))
        .toThrow(/cannot be whitelisted/i);
    }
  });

  it("rejects version-suffixed interpreter variants", () => {
    for (const name of ["python3.11", "python3.10", "python2.7", "node22", "node18", "perl5.36", "ruby3.2", "php8", "lua5.4", "bash5"]) {
      expect(() => parseExtraCommandsConfig(wrap({ [name]: { category: "general" } }), "t"))
        .toThrow(/cannot be whitelisted/i);
    }
  });

  it("does not over-block legitimate names that merely resemble an interpreter stem", () => {
    // iperf3 / sha256sum / show_gids / ib_write_bw end in or contain digits but are not
    // <interpreter><version> forms — they must remain configurable.
    for (const name of ["iperf3", "sha256sum", "show_gids", "ib_write_bw", "h5dump", "qperf"]) {
      expect(() => parseExtraCommandsConfig(wrap({ [name]: { category: "network" } }), "t")).not.toThrow();
    }
  });
});

// ── setExtraCommands (merge semantics) ──────────────────────────────

describe("setExtraCommands", () => {
  it("makes an extra command visible in matching contexts and invalidates the cache", () => {
    // Prime the cache first — registration must invalidate it.
    expect(getContextAllowedSet("node").has("iperf3")).toBe(false);
    expect(getContextAllowedSet("local").has("iperf3")).toBe(false);

    const result = setExtraCommands({ iperf3: { category: "network" } });
    expect(result.applied).toEqual(["iperf3"]);
    expect(result.skipped).toEqual([]);

    expect(getContextAllowedSet("node").has("iperf3")).toBe(true);
    expect(getContextAllowedSet("local").has("iperf3")).toBe(true);
  });

  it("respects context policies for the extra command's category", () => {
    setExtraCommands({ vendorcat: { category: "file" } });
    // "file" category is excluded from the local context policy
    expect(getContextAllowedSet("local").has("vendorcat")).toBe(false);
    expect(getContextAllowedSet("node").has("vendorcat")).toBe(true);
  });

  it("skips collisions with built-in commands and keeps built-in restrictions", () => {
    const result = setExtraCommands({
      curl: { category: "network" }, // would lift curl's method restrictions
      iperf3: { category: "network" },
    });
    expect(result.skipped).toEqual(["curl"]);
    expect(result.applied).toEqual(["iperf3"]);

    // Built-in curl validator still enforced
    const err = validateCommandRestrictions("curl -X POST http://example.com");
    expect(err).toContain("not allowed");
  });

  it("enforces declarative constraints on extra commands", () => {
    setExtraCommands({ iperf3: { category: "network", allowedFlags: ["-c", "-p"] } });
    expect(validateCommandRestrictions("iperf3 -c 10.0.0.1 -p 5201")).toBeNull();
    expect(validateCommandRestrictions("iperf3 -F /tmp/x")).toContain("not allowed");
  });

  it("replaces previous extras on each call", () => {
    setExtraCommands({ iperf3: { category: "network" } });
    setExtraCommands({ qperf: { category: "network" } });
    expect(getContextAllowedSet("node").has("iperf3")).toBe(false);
    expect(getContextAllowedSet("node").has("qperf")).toBe(true);
  });
});

// ── End-to-end through validateCommand ──────────────────────────────

describe("validateCommand with extra commands", () => {
  it("blocks an unregistered binary, allows it after registration", () => {
    expect(validateCommand("iperf3 -c 10.0.0.1", { context: "node" })).toContain("iperf3");
    setExtraCommands({ iperf3: { category: "network", allowedFlags: ["-c"] } });
    expect(validateCommand("iperf3 -c 10.0.0.1", { context: "node" })).toBeNull();
    expect(validateCommand("iperf3 -F /tmp/x", { context: "node" })).toContain("not allowed");
  });

  it("keeps category-based context exclusion for extras", () => {
    setExtraCommands({ vendorcat: { category: "file" } });
    expect(validateCommand("vendorcat /etc/hosts", { context: "local" })).toContain("vendorcat");
    expect(validateCommand("vendorcat /etc/hosts", { context: "node" })).toBeNull();
  });
});

// ── loadExtraCommands (file resolution) ─────────────────────────────

describe("loadExtraCommands", () => {
  let dir: string;
  const make = (content: string): string => {
    dir = mkdtempSync(join(tmpdir(), "siclaw-extra-"));
    const p = join(dir, "extra-commands.json");
    writeFileSync(p, content);
    return p;
  };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loads a valid file via explicit env path", () => {
    const p = make(JSON.stringify({ version: 1, commands: { iperf3: { category: "network" } } }));
    const loaded = loadExtraCommands({ envPath: p });
    expect(loaded).toEqual({ iperf3: { category: "network" } });
  });

  it("throws when the env path is set but the file is missing", () => {
    expect(() => loadExtraCommands({ envPath: "/nonexistent/extra.json" })).toThrow(/nonexistent/);
  });

  it("treats an empty env path as unset", () => {
    expect(loadExtraCommands({ envPath: "", defaultPath: "/nonexistent/extra.json" })).toBeNull();
  });

  it("returns null when only the default path is configured and absent", () => {
    expect(loadExtraCommands({ defaultPath: "/nonexistent/extra.json" })).toBeNull();
  });

  it("loads the default path when it exists", () => {
    const p = make(JSON.stringify({ version: 1, commands: { qperf: { category: "network" } } }));
    const loaded = loadExtraCommands({ defaultPath: p });
    expect(loaded).toEqual({ qperf: { category: "network" } });
  });

  it("throws on an invalid file even at the default path", () => {
    const p = make(JSON.stringify({ version: 1, commands: { curl2: { category: "bogus" } } }));
    expect(() => loadExtraCommands({ defaultPath: p })).toThrow(/category/);
  });
});

// ── The file that actually ships in the image ───────────────────────

// The file that carries THIS deployment's internal commands into the image. It is
// a four-link chain and every link is silent when it breaks: Dockerfile.agentbox
// COPYs it to the loader's default path, agent-factory loads it once at startup,
// the merged registry reaches all three exec tools. A wrong path is not an error —
// loadExtraCommands treats an absent default path as a no-op, so the commands just
// quietly stop being whitelisted. Each link is asserted here rather than reviewed.
describe("docker/extra-commands.json (internal commands shipped in the image)", () => {
  const repoRoot = new URL("../../../", import.meta.url);
  const shipped = fileURLToPath(new URL("docker/extra-commands.json", repoRoot));

  it("passes schema validation — a typo here is a broken image, not a rejected command", () => {
    expect(() => loadExtraCommands({ envPath: shipped })).not.toThrow();
  });

  it("is COPYed to the path the loader actually reads", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("Dockerfile.agentbox", repoRoot)), "utf8");
    const copy = dockerfile.match(/^COPY\s+docker\/extra-commands\.json\s+(\S+)\s*$/m);
    expect(copy, "Dockerfile.agentbox must COPY docker/extra-commands.json").not.toBeNull();
    expect(copy![1]).toBe(DEFAULT_EXTRA_COMMANDS_PATH);
  });

  it("registers every declared command into the node/host exec contexts", () => {
    const loaded = loadExtraCommands({ envPath: shipped }) ?? {};
    expect(Object.keys(loaded).length).toBeGreaterThan(0);
    setExtraCommands(loaded);
    for (const name of Object.keys(loaded)) {
      expect(getContextAllowedSet("node").has(name)).toBe(true);
      expect(getContextAllowedSet("host").has(name)).toBe(true);
    }
  });

  it("sichek admits the read-only components and refuses the rest", () => {
    setExtraCommands(loadExtraCommands({ envPath: shipped }) ?? {});
    for (const sub of ["all", "gpu", "g", "infiniband", "i", "gpfs", "f", "lldp", "l"]) {
      expect(validateCommand(`sichek ${sub}`, { context: "node" })).toBeNull();
    }
    // Everything whose position-0 subcommand is not on the list: the daemon, the
    // exporter, config sync, and the perf tests that put load on a live node.
    for (const sub of ["daemon", "exporter", "config", "ibtest", "rocetest", "nccltest"]) {
      expect(validateCommand(`sichek ${sub}`, { context: "node" })).not.toBeNull();
    }
  });

  it("mmlscluster reads GPFS config by absolute path, with no operands", () => {
    setExtraCommands(loadExtraCommands({ envPath: shipped }) ?? {});
    // Nothing puts it on PATH — the agent calls it where GPFS installs it.
    expect(validateCommand("/usr/lpp/mmfs/bin/mmlscluster --noinit", { context: "host" })).toBeNull();
    expect(validateCommand("mmlscluster --ces", { context: "node" })).toBeNull();
    // positionals: "block" — it takes none, so an operand is a typo or an injection.
    expect(validateCommand("mmlscluster /etc/shadow", { context: "host" })).not.toBeNull();
    // Its writer siblings are separate binaries and none of them is whitelisted.
    expect(validateCommand("mmchcluster -p node1", { context: "host" })).not.toBeNull();
    expect(validateCommand("mmshutdown -a", { context: "host" })).not.toBeNull();
  });
});

describe("contexts", () => {
  const wrap = (commands: unknown) => JSON.stringify({ version: 1, commands });

  it("accepts a valid context list", () => {
    const parsed = parseExtraCommandsConfig(
      wrap({ vendorctl: { category: "general", contexts: ["local"] } }), "t");
    expect(parsed.vendorctl.contexts).toEqual(["local"]);
  });

  it("rejects an unknown context rather than ignoring it", () => {
    // Fail-loud: a typo that silently dropped the field would widen the command to every context
    // its category allows — the opposite of what the author wrote.
    expect(() => parseExtraCommandsConfig(
      wrap({ vendorctl: { category: "general", contexts: ["agentbox"] } }), "t"))
      .toThrow(/contexts/);
  });

  it("rejects an empty context list", () => {
    expect(() => parseExtraCommandsConfig(
      wrap({ vendorctl: { category: "general", contexts: [] } }), "t"))
      .toThrow(/contexts/);
  });

  it("rejects an empty description rather than carrying a blank line into the tool prose", () => {
    expect(() => parseExtraCommandsConfig(
      wrap({ vendorctl: { category: "general", description: "  " } }), "t"))
      .toThrow(/description/);
  });
});

// End to end: a declaration in a drop-in file reaches the predicate the
// credential seam consults. Parsing it and honouring it are two steps, and a
// field that parses but is never read is the failure this pins.
describe("credentialFreeSubcommands → isCredentialFreeInvocation", () => {
  const wrap = (commands: unknown) => JSON.stringify({ version: 1, commands });

  afterEach(() => { setExtraCommands({}); });

  const register = () => {
    setExtraCommands(parseExtraCommandsConfig(wrap({
      vendorctl: {
        category: "general",
        allowedSubcommands: { position: 0, allowed: ["describe", "deploy", "build"] },
        credentialFreeSubcommands: { position: 0, subcommands: ["describe"] },
      },
    }), "t"));
  };

  it("is true for a declared subcommand", () => {
    register();
    expect(isCredentialFreeInvocation("vendorctl describe")).toBe(true);
  });

  it("locates the subcommand past leading flags, as the whitelist does", () => {
    register();
    expect(isCredentialFreeInvocation("vendorctl --pretty describe")).toBe(true);
    expect(isCredentialFreeInvocation("vendorctl --pretty deploy run")).toBe(false);
  });

  it("resolves through an absolute path and is case-insensitive on the binary", () => {
    register();
    expect(isCredentialFreeInvocation("/usr/local/bin/vendorctl describe")).toBe(true);
  });

  it("is false for an undeclared subcommand, a missing one, and an unknown binary", () => {
    register();
    expect(isCredentialFreeInvocation("vendorctl build list")).toBe(false);
    expect(isCredentialFreeInvocation("vendorctl")).toBe(false);
    expect(isCredentialFreeInvocation("someothertool describe")).toBe(false);
    expect(isCredentialFreeInvocation("")).toBe(false);
  });

  it("is false for a command that declares nothing — the fail-closed default", () => {
    setExtraCommands(parseExtraCommandsConfig(wrap({
      vendorctl: { category: "general", allowedSubcommands: { position: 0, allowed: ["describe"] } },
    }), "t"));
    expect(isCredentialFreeInvocation("vendorctl describe")).toBe(false);
  });
});
