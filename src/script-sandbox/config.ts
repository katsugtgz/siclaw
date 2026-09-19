import { readFileSync } from "node:fs";
import { ScriptSandboxError, type ScriptSandboxConfig } from "./types.js";

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ScriptSandboxError("Invalid script sandbox boolean configuration");
}

function integer(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ScriptSandboxError("Invalid script sandbox limit configuration");
  }
  return parsed;
}

export function loadScriptSandboxConfig(env: NodeJS.ProcessEnv = process.env,
  settings?: { get(): { enabled: boolean } }): ScriptSandboxConfig {
  // PROVISIONED says the chart created this Runtime's execution namespace, RBAC
  // and quota. It is NOT the feature switch — the control plane owns that, so
  // that a region can be opened, closed or repointed without a redeploy. The
  // legacy _ENABLED name keeps provisioning an already-deployed values file.
  const provisioned = bool(env.SICLAW_SCRIPT_SANDBOX_PROVISIONED ?? env.SICLAW_SCRIPT_SANDBOX_ENABLED);
  // Unprovisioned deployments must not read secrets or validate unused providers.
  if (!provisioned) env = {};
  const provider = env.SICLAW_SCRIPT_SANDBOX_PROVIDER ?? "k8s";
  if (!["k8s", "docker", "e2b"].includes(provider)) throw new ScriptSandboxError("Unknown script sandbox provider");
  // The runner image belongs to the RELEASE, not to operations: helm derives
  // {registry}/siclaw-script-sandbox:{tag} from this Runtime's own image (the
  // agentbox rule), and scriptSandbox.image overrides it. So a Runtime runs the
  // runner it shipped with, and an upgrade moves both together.
  // The control plane deliberately has no say here — it used to carry a
  // per-Runtime image, which meant an upgraded Runtime kept launching whatever
  // runner someone had typed into a console months earlier.
  const image = env.SICLAW_SCRIPT_SANDBOX_IMAGE ?? "";
  if (image && /\s/.test(image)) throw new ScriptSandboxError("SICLAW_SCRIPT_SANDBOX_IMAGE is invalid");
  let e2b: ScriptSandboxConfig["e2b"];
  if (provisioned && provider === "e2b") {
    const apiKey = env.SICLAW_SCRIPT_SANDBOX_E2B_API_KEY_FILE
      ? readFileSync(env.SICLAW_SCRIPT_SANDBOX_E2B_API_KEY_FILE, "utf8").trim()
      : env.E2B_API_KEY ?? "";
    const template = env.SICLAW_SCRIPT_SANDBOX_E2B_TEMPLATE ?? "";
    const apiUrl = env.SICLAW_SCRIPT_SANDBOX_E2B_API_URL ?? "https://api.e2b.app";
    const domain = env.SICLAW_SCRIPT_SANDBOX_E2B_DOMAIN ?? "e2b.app";
    let validUrl = false;
    try { const u = new URL(apiUrl); validUrl = u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/"; } catch {}
    if (!apiKey || /\s/.test(apiKey) || !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/.test(template) ||
      !validUrl || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(domain)) throw new ScriptSandboxError("Invalid E2B service configuration");
    e2b = { apiKey, template, apiUrl, domain };
  }
  const readMcpPolicy = (): ScriptSandboxConfig["mcpPolicy"] => {
    const mcpPolicy = env.SICLAW_SCRIPT_SANDBOX_MCP_POLICY_FILE
      ? JSON.parse(readFileSync(env.SICLAW_SCRIPT_SANDBOX_MCP_POLICY_FILE, "utf8")) : {};
    if (!mcpPolicy || Array.isArray(mcpPolicy) || typeof mcpPolicy !== "object") throw new ScriptSandboxError("Invalid sandbox MCP policy");
    for (const tools of Object.values(mcpPolicy)) {
      if (!tools || Array.isArray(tools) || typeof tools !== "object") throw new ScriptSandboxError("Invalid sandbox MCP tool policy");
      for (const policy of Object.values(tools)) {
        if (!policy || Array.isArray(policy) || typeof policy !== "object" || Object.keys(policy).some(k => k !== "fixedArguments")) {
          throw new ScriptSandboxError("Invalid sandbox MCP operation policy");
        }
        if (policy.fixedArguments !== undefined && (!policy.fixedArguments || Array.isArray(policy.fixedArguments) || typeof policy.fixedArguments !== "object")) {
          throw new ScriptSandboxError("Invalid sandbox MCP fixed arguments");
        }
      }
    }
    return mcpPolicy;
  };
  const readHostKeys = (): ScriptSandboxConfig["hostKeyPins"] => {
    const pins = env.SICLAW_SCRIPT_SANDBOX_HOST_KEYS_FILE ? JSON.parse(readFileSync(env.SICLAW_SCRIPT_SANDBOX_HOST_KEYS_FILE, "utf8")) : {};
    if (!pins || Array.isArray(pins) || typeof pins !== "object" || Object.values(pins).some(v => typeof v !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(v))) throw new ScriptSandboxError("Invalid sandbox host key pins");
    return pins;
  };
  const mcpPolicy = readMcpPolicy(), hostKeyPins = readHostKeys();
  return {
    // Read the current projected file on each authorization. Failed reloads
    // deny access; a stale allowlist must never survive a policy replacement.
    get hostKeyPins() { return env.SICLAW_SCRIPT_SANDBOX_HOST_KEYS_FILE ? readHostKeys() : hostKeyPins; },
    provisioned,
    // Re-read on every access: flipping the switch in the control plane must
    // take effect without recycling a Runtime.
    get enabled() {
      if (!provisioned) return false;
      // No control plane wired (smoke harness, standalone test rig): the
      // deployment flag is the only switch that ever existed there.
      if (settings && !settings.get().enabled) return false;
      // No runner image would hand the model a tool that fails on every call.
      // Report it closed instead. Since the image is derived from the release,
      // the only way to land here is a deployment that overrode it with an
      // empty value — in which case the operator is looking at their own values.
      return provider === "e2b" || !!image;
    },
    image,
    provider: provider as ScriptSandboxConfig["provider"], e2b,
    namespace: env.SICLAW_SCRIPT_SANDBOX_NAMESPACE ?? "siclaw-execution",
    serviceAccount: env.SICLAW_SCRIPT_SANDBOX_SERVICE_ACCOUNT ?? "siclaw-script-runner",
    runtimeClass: env.SICLAW_SCRIPT_SANDBOX_RUNTIME_CLASS || undefined,
    networkIsolation: bool(env.SICLAW_SCRIPT_SANDBOX_NETWORK_ISOLATION),
    requireNetworkIsolation: bool(env.SICLAW_SCRIPT_SANDBOX_REQUIRE_NETWORK_ISOLATION),
    maxTimeoutSeconds: integer(env.SICLAW_SCRIPT_SANDBOX_MAX_TIMEOUT_SECONDS, 300, 600),
    maxConcurrentRuns: integer(env.SICLAW_SCRIPT_SANDBOX_MAX_CONCURRENT_RUNS, 10, 100),
    warmPoolSize: env.SICLAW_SCRIPT_SANDBOX_WARM_POOL_SIZE === "0" ? 0 : integer(env.SICLAW_SCRIPT_SANDBOX_WARM_POOL_SIZE, 1, 8),
    warmIdleSeconds: integer(env.SICLAW_SCRIPT_SANDBOX_WARM_IDLE_SECONDS, 300, 1800),
    maxOutputBytes: integer(env.SICLAW_SCRIPT_SANDBOX_MAX_OUTPUT_BYTES, 128 * 1024, 1024 * 1024),
    maxToolCalls: integer(env.SICLAW_SCRIPT_SANDBOX_MAX_TOOL_CALLS, 512, 1000),
    get mcpPolicy() { return env.SICLAW_SCRIPT_SANDBOX_MCP_POLICY_FILE ? readMcpPolicy() : mcpPolicy; },
  };
}
