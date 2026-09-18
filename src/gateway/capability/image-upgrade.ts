import type { CapabilityRunRecord } from "./run-manager.js";
import { isTerminalCapabilityStatus } from "./contract.js";

export interface ImageUpgradeAdmission {
  version: number;
  run_id: string;
  allowed: boolean;
  continuation: boolean;
}

export interface ImageUpgradeDependencies {
  current(runId: string): CapabilityRunRecord | undefined;
  outdated(run: CapabilityRunRecord): Promise<boolean>;
  admission(run: CapabilityRunRecord): Promise<ImageUpgradeAdmission>;
  prepare(run: CapabilityRunRecord, continuation: boolean): Promise<{ version: number; run_id: string; state: string }>;
  checkpoint(run: CapabilityRunRecord, continuation: boolean): Promise<void>;
  stop(run: CapabilityRunRecord): Promise<void>;
  complete(run: CapabilityRunRecord, continuation: boolean): Promise<void>;
}

/** Retire only a box that fenced new work and acknowledged its durable snapshot.
 * Domain continuation remains owned by the consumer, not by box acquisition.
 */
export class CapabilityImageUpgrade {
  private retiring = new Map<string, boolean>();
  private stopping = new Set<string>();

  constructor(private readonly deps: ImageUpgradeDependencies) {}

  ownsRetirement(runId: string): boolean {
    if (!this.deps.current(runId)) {
      this.retiring.delete(runId);
      this.stopping.delete(runId);
    }
    return this.stopping.has(runId);
  }

  async check(run: CapabilityRunRecord): Promise<void> {
    for (const id of this.retiring.keys()) {
      if (!this.deps.current(id)) {
        this.retiring.delete(id);
        this.stopping.delete(id);
      }
    }
    if (this.deps.current(run.runId) !== run) {
      this.retiring.delete(run.runId);
      this.stopping.delete(run.runId);
      return;
    }
    if (isTerminalCapabilityStatus(run.status)) return;
    if (run.profile !== "kb-compile" && run.profile !== "kb-compile-codex") return;
    if (run.imageUpgradePending !== undefined) this.retiring.set(run.runId, run.imageUpgradePending);
    if (!this.retiring.has(run.runId)) {
      if (run.status !== "idle" || !(await this.deps.outdated(run))) return;
      const admission = await this.deps.admission(run);
      if (admission.version !== 1 || admission.run_id !== run.runId || admission.allowed !== true || typeof admission.continuation !== "boolean") return;
      if (this.deps.current(run.runId) !== run || run.status !== "idle") return;
      const prepared = await this.deps.prepare(run, admission.continuation);
      if (prepared.version !== 1 || prepared.run_id !== run.runId || prepared.state !== "ready") return;
      if (this.deps.current(run.runId) !== run || isTerminalCapabilityStatus(run.status)) return;
      // The box now rejects new work. A concurrent dispatch can temporarily set
      // Runtime's status to running, but cannot execute past that box fence.
      this.retiring.set(run.runId, admission.continuation);
    }
    // A failed stop keeps retirement ownership; a later tick retries cleanup.
    // Never announce a recoverable failure before the old writer is stopped.
    await this.deps.checkpoint(run, this.retiring.get(run.runId)!);
    if (this.deps.current(run.runId) !== run || isTerminalCapabilityStatus(run.status)) return;
    this.stopping.add(run.runId);
    await this.deps.stop(run);
    if (this.deps.current(run.runId) === run) {
      await this.deps.complete(run, this.retiring.get(run.runId)!);
    }
    this.retiring.delete(run.runId);
    this.stopping.delete(run.runId);
  }
}
