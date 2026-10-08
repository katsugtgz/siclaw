/**
 * How long an execution grant stays valid without a fresh confirmation.
 *
 * ONE number for both ends: the Runtime's registry (gateway/execution-grants.ts)
 * and the box's manager (agentbox/box-grants.ts) each read it, and the box must
 * never outlive the Runtime's view of a grant. It lives in `shared/` because the
 * box image must not import the gateway; it was defined once on each side, both
 * reading the same env var, and nothing held the two together.
 *
 * Design: docs/design/2026-09-24-agentbox-session-isolation.zh-CN.md §6.5 (60s
 * upper bound, decision 4).
 */

export const DEFAULT_GRANT_LEASE_MS = 60_000;

export const GRANT_LEASE_ENV = "SICLAW_EXECUTION_GRANT_LEASE_MS";

/** The configured lease, or the default when unset, unparsable or under one second. */
export function grantLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[GRANT_LEASE_ENV]);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : DEFAULT_GRANT_LEASE_MS;
}
