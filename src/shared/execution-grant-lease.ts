/**
 * How long an execution grant stays valid without a fresh confirmation.
 *
 * ONE number for both ends: the Runtime's registry (gateway/execution-grants.ts)
 * and the box's manager (agentbox/execution-grants.ts) enforce the same hard
 * limit, and the box must never outlive the Runtime's view of a grant. The
 * Runtime may configure a shorter lease; the box validates the wire duration
 * instead of reading a second deployment setting. This lives in `shared/`
 * because the box image must not import the gateway.
 *
 * Design: docs/design/2026-09-24-agentbox-session-isolation.zh-CN.md §6.5 (60s
 * upper bound, decision 4).
 */

export const DEFAULT_GRANT_LEASE_MS = 60_000;
export const MAX_GRANT_LEASE_MS = 60_000;

export const GRANT_LEASE_ENV = "SICLAW_EXECUTION_GRANT_LEASE_MS";

/** Invalid durations use the safe default; configuration can only shorten the hard limit. */
export function normalizeGrantLeaseMs(value: number): number {
  return Number.isSafeInteger(value) && value >= 1_000
    ? Math.min(value, MAX_GRANT_LEASE_MS) : DEFAULT_GRANT_LEASE_MS;
}

/** Whole milliseconds only. Never extend authorization beyond the revocation bound. */
export function grantLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  return normalizeGrantLeaseMs(Number(env[GRANT_LEASE_ENV]));
}
