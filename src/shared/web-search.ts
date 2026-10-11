export type WebSearchMode = "disabled" | "enabled" | "cached" | "live";

/** Trusted Agent setting only. Missing legacy configuration never widens egress. */
export function resolveWebSearchMode(value: unknown): WebSearchMode {
  if (value === undefined || value === null || value === "") return "disabled";
  if (value === "disabled" || value === "enabled" || value === "cached" || value === "live") return value;
  throw new Error("Unsupported Agent web search configuration");
}
