import { REQUEST_QUEUE_TIMEOUT_MS } from "../shared/request-mode.js";

/** Retry only explicit pre-prompt busy refusals. Never retry a timeout, lost
 * acknowledgement, engine change, provider error or ambiguous execution. */
export async function dispatchQueuedPrompt<T>(
  send: () => Promise<T>,
  signal: AbortSignal,
  waitMs = 200,
  timeoutMs = REQUEST_QUEUE_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await send();
    } catch (error) {
      const status =
        error && typeof error === "object"
          ? (error as { status?: number }).status
          : undefined;
      const message = error instanceof Error ? error.message : "";
      if (
        status !== 409 ||
        !(
          message.startsWith("Session is already running") ||
          message === "Session execution authorization is still in use"
        ) ||
        Date.now() >= deadline
      )
        throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Queued input cancelled"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, waitMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}
