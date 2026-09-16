/** Admission of user input, independent of provider streaming and child parallelism. */
export type RequestMode = "sync" | "async";

export function parseRequestMode(value: unknown): RequestMode {
  if (value === undefined) return "async";
  if (value === "sync" || value === "async") return value;
  throw new Error("requestMode must be sync or async");
}

export const REQUEST_QUEUE_TIMEOUT_MS = 30 * 60_000;

/** Capability responses are wire data; a string like "async" is not a mode list. */
export function supportsRequestMode(modes: unknown, mode: RequestMode): boolean {
  return Array.isArray(modes) && modes.includes(mode);
}
