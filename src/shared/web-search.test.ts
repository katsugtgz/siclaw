import { expect, it } from "vitest";
import { resolveWebSearchMode } from "./web-search.js";
it("requires an exact trusted search mode and defaults legacy Agents to disabled", () => {
  for (const value of [undefined, null, ""]) expect(resolveWebSearchMode(value)).toBe("disabled");
  for (const value of ["disabled", "enabled", "cached", "live"] as const) expect(resolveWebSearchMode(value)).toBe(value);
  for (const value of [true, "unknown", " LIVE", {}, []]) expect(() => resolveWebSearchMode(value)).toThrow();
});
