import { describe, expect, it } from "vitest";
import { DEFAULT_GRANT_LEASE_MS, GRANT_LEASE_ENV, grantLeaseMs } from "./execution-grant-lease.js";

describe("bounded execution grant lease configuration", () => {
  it.each([undefined, "", " ", "invalid", "NaN", "Infinity", "-1", "0", "999", "1000.5", "9007199254740993"])(
    "uses the safe default for invalid configuration %s", value => {
      expect(grantLeaseMs(value === undefined ? {} : { [GRANT_LEASE_ENV]: value })).toBe(DEFAULT_GRANT_LEASE_MS);
    });

  it.each([1000, 1500, 30_000, 59_999, 60_000])("preserves a shorter integer lease of %i ms", value => {
    expect(grantLeaseMs({ [GRANT_LEASE_ENV]: String(value) })).toBe(value);
  });

  it.each([60_001, 3_600_000, Number.MAX_SAFE_INTEGER])("caps a configured lease of %i ms at 60 seconds", value => {
    expect(grantLeaseMs({ [GRANT_LEASE_ENV]: String(value) })).toBe(60_000);
  });
});
