import { describe, expect, it } from "vitest";
import { channelExecutionContext, executionAuditUser, executionOwnerKey } from "./execution-context.js";

describe("channel execution identity", () => {
  it("accepts the group's identity without borrowing a creator", () => {
    const context = channelExecutionContext({ bindingId: "b", routeType: "group", createdBy: "",
      identity: { kind: "binding", id: "b" }, sender: { userId: "alice", openId: "ou_a" }, origin: "channel" }, true);
    expect(context.identity).toEqual({ kind: "binding", id: "b" });
    expect(executionOwnerKey(context.identity, "s")).toBe("binding_b");
    expect(executionAuditUser(context)).toBe("alice");
  });
  it("never replaces none with the creator", () => {
    const context = channelExecutionContext({ createdBy: "admin", identity: { kind: "none" } }, true);
    expect(context.identity.kind).toBe("none");
  });
  it.each([{ kind: "admin", id: "root" }, { kind: "binding" }, { kind: "binding", id: "other" }, null])(
    "refuses malformed or foreign identity %j", identity => {
      expect(() => channelExecutionContext({ bindingId: "b", createdBy: "admin", identity }, true)).toThrow();
    });
  it("requires identities from a declaring control plane", () => {
    expect(() => channelExecutionContext({ createdBy: "admin" }, true)).toThrow();
    expect(channelExecutionContext({ createdBy: "user" }, false).identity).toEqual({ kind: "user", id: "user" });
  });
});
