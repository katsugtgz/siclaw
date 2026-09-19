import { ScriptSandboxError } from "./types.js";

/** The per-Runtime sandbox switch, owned by the control plane rather than by the
 * deployment: whether a region gets run_script is an operational decision that
 * must be changeable without a redeploy. The chart provisions the execution
 * namespace, RBAC and quota, and ships the runner image with the release.
 *
 * The switch is ALL the control plane owns. It used to send a runner image too;
 * that made an upgraded Runtime keep launching a runner someone had typed into a
 * console months earlier, so the image moved back to the chart. A control plane
 * that still sends one is simply ignored. */
export interface RuntimeSandboxSettings {
  enabled: boolean;
}

export interface RuntimeSettingsSource {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

const CLOSED: RuntimeSandboxSettings = { enabled: false };

export function parseRuntimeSandboxSettings(payload: unknown): RuntimeSandboxSettings {
  if (!payload || typeof payload !== "object") throw new ScriptSandboxError("Invalid runtime sandbox settings");
  const sandbox = (payload as Record<string, unknown>).script_sandbox;
  // A control plane that does not know this key yet answers without it. That is
  // "not configured", which is CLOSED — never "inherit whatever the pod has".
  if (sandbox === undefined || sandbox === null) return CLOSED;
  if (typeof sandbox !== "object") throw new ScriptSandboxError("Invalid runtime sandbox settings");
  // Only `enabled` is read. An older control plane also sends `image`; ignoring
  // it is the point — the runner comes from this Runtime's own release.
  const { enabled } = sandbox as Record<string, unknown>;
  if (enabled !== undefined && typeof enabled !== "boolean") throw new ScriptSandboxError("Invalid runtime sandbox switch");
  return { enabled: enabled === true };
}

/** Caches the control plane's answer and keeps serving it while the control
 * plane is unreachable.
 *
 * Two different failures, two different answers. Never having reached the
 * control plane is indistinguishable from "this Runtime was never turned on",
 * so it stays CLOSED. Losing a control plane that already said yes is a
 * transient fault, and dropping a working feature mid-turn would be a worse
 * outcome than serving a slightly stale switch — so the last successful answer
 * is kept until it is replaced. */
export class ScriptSandboxRuntimeSettings {
  private value?: RuntimeSandboxSettings;
  private expires = 0;
  private pending?: Promise<void>;

  constructor(private readonly source: RuntimeSettingsSource, private readonly ttlMs = 15_000,
    private readonly now: () => number = Date.now) {}

  /** Synchronous, never throws: providers read the image on every Job build. */
  get(): RuntimeSandboxSettings {
    return this.value ?? CLOSED;
  }

  /** Whether an answer has ever been received. Before that, `get()` reports
   * CLOSED because nothing is known — which is not the same statement as the
   * control plane having said "closed", and callers that would otherwise turn a
   * cold start into a refusal need to tell the two apart. */
  get primed(): boolean {
    return this.value !== undefined;
  }

  /** Refreshes when stale. Callers await it on the paths that publish the
   * switch; a failure leaves `get()` on its previous answer. */
  async ensureFresh(): Promise<RuntimeSandboxSettings> {
    // Gated on the deadline ALONE. Also requiring a cached value would exempt
    // the failing case from its own back-off: a control plane that is down
    // leaves `value` unset, so every caller would redial it.
    if (this.now() < this.expires) return this.get();
    this.pending ??= this.refresh().finally(() => { this.pending = undefined; });
    await this.pending;
    return this.get();
  }

  private async refresh(): Promise<void> {
    try {
      const settings = parseRuntimeSandboxSettings(await this.source.request("config.getRuntimeConfig", {}, 10_000));
      const previous = this.value;
      this.value = settings;
      this.expires = this.now() + this.ttlMs;
      // Only on a CHANGE — this refreshes every TTL, and a line per poll would
      // bury the one moment an operator needs to see. Without it, flipping the
      // switch in the console has no observable effect on this side at all:
      // the runner Pods are created per run, so a Runtime that silently
      // disagrees with the console looks identical to one that agrees.
      if (!previous || previous.enabled !== settings.enabled) {
        console.info(`[script-sandbox] control plane says ${settings.enabled ? "OPEN" : "CLOSED"}`);
      }
    } catch (error) {
      // Back off for one TTL either way: a control plane that is down must not
      // be re-dialled once per Job build.
      this.expires = this.now() + this.ttlMs;
      console.warn(`[script-sandbox] runtime settings unavailable (${this.value ? "keeping last known" : "staying disabled"}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
