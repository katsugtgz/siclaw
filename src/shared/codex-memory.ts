/** Trusted Agent setting. Older control planes preserve native Codex's existing
 * enabled behavior; malformed values must never be interpreted as a toggle. */
export function resolveCodexMemoryEnabled(value: unknown): boolean {
  if(value===undefined||value===null)return true;
  if(typeof value!=="boolean")throw new Error("Invalid Codex memory setting");
  return value;
}
