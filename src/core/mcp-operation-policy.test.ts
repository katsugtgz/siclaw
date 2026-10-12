import { describe, expect, it } from "vitest";
import { authorizeMcpArguments, mcpDigest, resolveMcpToolRules } from "./mcp-operation-policy.js";

describe("operator-owned MCP argument governance", () => {
  it("binds fixed tenant and nested namespace without mutating caller arguments", () => {
    const rule = resolveMcpToolRules({ version: 1, tools: { query: { effect: "read", fixedArguments: { "/tenant": "team-a" },
      allowedArguments: { "/target/namespace": ["sicore-test"] } } } })!.get("query");
    const args = { target: { namespace: "sicore-test" } };
    expect(authorizeMcpArguments(rule, args)).toEqual({ ...args, tenant: "team-a" });
    expect(args).not.toHaveProperty("tenant");
    expect(() => authorizeMcpArguments(rule, { ...args, tenant: "team-b" })).toThrow(/override denied/);
    expect(() => authorizeMcpArguments(rule, { target: { namespace: "default" } })).toThrow(/outside/);
    expect(() => authorizeMcpArguments(rule, {})).toThrow(/required/);
  });
  it("does not infer write authority from an explicit write rule or a tool annotation", () => {
    const rules = resolveMcpToolRules({ version: 1, tools: { mutate: { effect: "write" } } })!;
    expect(() => authorizeMcpArguments(rules.get("mutate"), {})).toThrow(/approval grant/);
  });
  it("allows exact backend-authorized calls while preserving fixed scope and default write denial", () => {
    const rules = resolveMcpToolRules({ version: 1, tools: {
      propose_deploy_run: { effect: "write", authorization: "backend", fixedArguments: { "/project": "project-a" } },
      deploy_run: { effect: "write" },
    } })!;
    expect(authorizeMcpArguments(rules.get("propose_deploy_run"), { version: "v1" }))
      .toEqual({ version: "v1", project: "project-a" });
    expect(() => authorizeMcpArguments(rules.get("propose_deploy_run"), { project: "project-b" })).toThrow(/override/);
    expect(() => authorizeMcpArguments(rules.get("deploy_run"), {})).toThrow(/approval grant/);
    for (const rule of [{ effect: "read", authorization: "backend" },
      { effect: "write", authorization: "model" }, { effect: "write", authorization: true }]) {
      expect(() => resolveMcpToolRules({ version: 1, tools: { query: rule } })).toThrow();
    }
    for (const rule of [{ effect: "read", publicResultPaths: ["/claim_token"] },
      { effect: "write", authorization: "backend", publicResultPaths: ["/proposals/*/claim_token"] },
      { effect: "write", authorization: "backend", publicResultPaths: ["/__proto__/token"] }]) {
      expect(() => resolveMcpToolRules({ version: 1, tools: { result: rule } })).toThrow();
    }
  });
  it("rejects unknown versions, malformed constraints and prototype paths", () => {
    for (const policy of [{ version: 2, tools: {} }, { version: 1, tools: { "*": { effect: "read" } } },
      { version: 1, tools: { query: { effect: "read", allowedArguments: { "/ns": [] } } } },
      { version: 1, tools: { query: { effect: "read", fixedArguments: { "/__proto__/x": true } } } },
      { version: 1, tools: { query: { effect: "read", roles: ["admin"] } } }]) {
      expect(() => resolveMcpToolRules(policy)).toThrow();
    }
    expect({}).not.toHaveProperty("x");
  });
  it("uses order-independent typed digests and preserves JSON pointer escaping", () => {
    expect(mcpDigest({ a: 1, b: false })).toBe(mcpDigest({ b: false, a: 1 }));
    expect(mcpDigest(1)).not.toBe(mcpDigest("1"));
    expect(() => mcpDigest({ a: undefined })).toThrow();
    expect(authorizeMcpArguments({ effect: "read", fixedArguments: { "/a~1b": 1 } }, {})).toEqual({ "a/b": 1 });
  });
});
