/** Mail addressed to one active user turn. Closing it never starts another turn. */
export class AgentMailbox {
  private messages: string[] = [];
  private delivered: string[] = [];
  private listeners = new Set<(outcome: "mail" | "closed" | "steered") => void>();
  private closed = false;
  private accepting = true;

  get ready(): boolean { return !this.closed && this.accepting && this.messages.length > 0; }

  post(message: string): boolean {
    if (this.closed) return false;
    this.messages.push(message);
    for (const listener of this.listeners) listener("mail");
    return true;
  }

  /** A final/unknown-phase answer defers mail; tools and user steering reopen it. */
  defer(): void { this.accepting = false; }
  reopen(): void { if (!this.closed) this.accepting = true; }

  steer(): void {
    this.reopen();
    for (const listener of this.listeners) listener("steered");
  }

  take(): string | undefined {
    if (!this.ready) return undefined;
    const batch = this.messages.splice(0);
    this.delivered.push(...batch);
    return batch.join("\n\n");
  }

  checkpoint(): number { return this.delivered.length; }

  /** Routing rolls transcript history back; replay only mail consumed by that attempt. */
  rollback(checkpoint: number): void {
    if (this.closed) return;
    this.messages.unshift(...this.delivered.splice(checkpoint));
    this.reopen();
  }

  close(): void {
    this.closed = true;
    this.messages = [];
    this.delivered = [];
    for (const listener of this.listeners) listener("closed");
  }

  /** Wait for activity, not for a successful result; never consumes mail or stops jobs. */
  wait(timeoutMs: number, signal?: AbortSignal): Promise<"mail" | "timeout" | "closed" | "aborted" | "steered"> {
    if (signal?.aborted) return Promise.resolve("aborted");
    if (this.closed) return Promise.resolve("closed");
    if (this.messages.length) return Promise.resolve("mail");
    return new Promise(resolve => {
      const finish = (outcome: "mail" | "timeout" | "closed" | "aborted" | "steered") => {
        clearTimeout(timer);
        this.listeners.delete(onActivity);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onActivity = (outcome: "mail" | "closed" | "steered") => finish(outcome);
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      this.listeners.add(onActivity);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
