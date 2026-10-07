import { createHash } from "node:crypto";

/** Operator-owned policy, never MCP annotations or model-provided identity. */
export const MCP_OPERATION_POLICY_ENV = "SICLAW_MCP_OPERATION_POLICY";
export interface McpToolRule {
  effect: "read" | "write";
  fixedArguments?: Record<string, unknown>;
  allowedArguments?: Record<string, unknown[]>;
}

export function mcpDigest(value: unknown): string {
  let nodes = 0;
  const canonical = (item: unknown, depth: number): unknown => {
    if (++nodes > 100_000 || depth > 48) throw new Error("MCP authorization value exceeds budget");
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(value => canonical(value, depth + 1));
    if (object(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key], depth + 1)]));
    throw new Error("MCP authorization requires JSON values");
  };
  const encoded = JSON.stringify(canonical(value, 0));
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error("MCP authorization value exceeds budget");
  return createHash("sha256").update(encoded).digest("hex");
}

/** A present policy is authoritative. Write rules are retained for governance
 * but never executable in v1: a future approval contract must explicitly enable them. */
export function resolveMcpToolRules(value: unknown): ReadonlyMap<string, McpToolRule> | undefined {
  if (value === undefined) return;
  if (typeof value === "string" && Buffer.byteLength(value) > 1024 * 1024) throw new Error("MCP operation policy exceeds budget");
  const policy: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!object(policy) || Object.keys(policy).some(key => key !== "version" && key !== "tools") || policy.version !== 1 ||
      !object(policy.tools) || Object.keys(policy.tools).length > 1000) throw new Error("Invalid MCP operation policy");
  const rules = new Map<string, McpToolRule>();
  for (const [name, raw] of Object.entries(policy.tools)) {
    if (!name || name.length > 4096 || /[*\x00-\x1f]/.test(name) || !object(raw) ||
        !["read", "write"].includes(String(raw.effect)) ||
        Object.keys(raw).some(key => !["effect", "fixedArguments", "allowedArguments"].includes(key))) throw new Error("Invalid MCP tool rule");
    for (const field of ["fixedArguments", "allowedArguments"] as const) {
      if (raw[field] !== undefined && (!object(raw[field]) || Object.keys(raw[field]).length > 128)) throw new Error("Invalid MCP argument rule");
      for (const [pointer, constraint] of Object.entries((raw[field] ?? {}) as Record<string, unknown>)) {
        pointerParts(pointer);
        if (field === "allowedArguments" && (!Array.isArray(constraint) || !constraint.length || constraint.length > 1000)) throw new Error("Invalid MCP argument choices");
        mcpDigest(constraint);
      }
    }
    rules.set(name, structuredClone(raw) as unknown as McpToolRule);
  }
  return rules;
}

/** Exact JSON-pointer constraints. No regex, wildcard, executable expression,
 * coercion, or caller-supplied tenant/user override. Original args stay untouched. */
export function authorizeMcpArguments(rule: McpToolRule | undefined, args: unknown): Record<string, unknown> {
  if (rule?.effect === "write") throw new Error("MCP write operations require a separate approval grant and are unavailable");
  if (!object(args)) throw new Error("MCP arguments must be an object");
  mcpDigest(args);
  const approved = structuredClone(args);
  for (const [pointer, expected] of Object.entries(rule?.fixedArguments ?? {})) {
    const parts = pointerParts(pointer);
    let parent = approved;
    for (const key of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent, key)) Object.defineProperty(parent, key, { value: {}, writable: true, enumerable: true, configurable: true });
      if (!object(parent[key])) throw new Error("MCP fixed argument cannot replace a non-object parent");
      parent = parent[key];
    }
    const key = parts.at(-1)!;
    if (Object.hasOwn(parent, key) && mcpDigest(parent[key]) !== mcpDigest(expected)) throw new Error("MCP fixed argument override denied");
    Object.defineProperty(parent, key, { value: structuredClone(expected), writable: true, enumerable: true, configurable: true });
  }
  for (const [pointer, choices] of Object.entries(rule?.allowedArguments ?? {})) {
    let value: unknown = approved;
    for (const key of pointerParts(pointer)) {
      if (!object(value) || !Object.hasOwn(value, key)) throw new Error("MCP scoped argument is required");
      value = value[key];
    }
    if (!choices.some(choice => mcpDigest(choice) === mcpDigest(value))) throw new Error("MCP argument is outside the authorized scope");
  }
  return approved;
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer.length > 4096) throw new Error("MCP argument rule requires a JSON pointer");
  const parts = pointer.slice(1).split("/");
  if (!parts.length || parts.some(part => !part || /~(?![01])/.test(part))) throw new Error("Invalid MCP argument pointer");
  const decoded = parts.map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (decoded.some(part => ["__proto__", "prototype", "constructor"].includes(part))) throw new Error("Unsafe MCP argument pointer");
  return decoded;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
