import { describe, it, expect } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { webExecutionScope, decodeWebExecutionScope, sourceAgentId } from "./web-execution-scope.js";
import { matchesSessionPrincipal } from "../gateway/security/session-principal.js";

describe("private Web execution scopes", () => {
  it("round-trips without collisions or Kubernetes truncation across restarts", () => {
    const scopes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const agentId = randomUUID(); const userId = `web_${randomBytes(16).toString("hex")}`;
      const scope = webExecutionScope(agentId, userId);
      expect(scope).toMatch(/^[0-9a-z]{50}$/);
      expect(decodeWebExecutionScope(scope)).toEqual({agentId, userId});
      expect(sourceAgentId(scope)).toBe(agentId);
      expect(scopes.has(scope)).toBe(false); scopes.add(scope);
      expect(webExecutionScope(agentId, userId)).toBe(scope);
    }
  });
  it("keeps ordinary callers in the existing Agent pool", () => {
    expect(webExecutionScope("agent", "user")).toBe("agent");
    expect(() => webExecutionScope("agent", `web_${"a".repeat(32)}`)).toThrow();
    expect(() => webExecutionScope(randomUUID(), "web_invalid")).toThrow();
  });
  it("separates two Agents and two users", () => {
    const a = randomUUID(), b = randomUUID(), u = `web_${"1".repeat(32)}`, v = `web_${"2".repeat(32)}`;
    expect(new Set([webExecutionScope(a,u), webExecutionScope(a,v), webExecutionScope(b,u)]).size).toBe(3);
    const alice = {agentId:a, privateUserId:u};
    expect(matchesSessionPrincipal(alice,{agentId:a,userId:u})).toBe(true);
    expect(matchesSessionPrincipal(alice,{agentId:a,userId:v})).toBe(false);
    expect(matchesSessionPrincipal(alice,{agentId:b,userId:u})).toBe(false);
    expect(matchesSessionPrincipal({agentId:a},{agentId:a,userId:u})).toBe(false);
    expect(matchesSessionPrincipal(alice,{agentId:a,userId:"console-user"})).toBe(false);
  });
});
