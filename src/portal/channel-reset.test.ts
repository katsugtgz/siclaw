import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, initDb } from "../gateway/db.js";
import { buildAdapterRpcHandlers } from "./adapter.js";
import { runPortalMigrations } from "./migrate.js";

describe("card session reset persistence", () => {
  beforeEach(async () => {
    initDb("sqlite::memory:");
    await runPortalMigrations();
    const db = getDb();
    await db.query("INSERT INTO agents (id, name) VALUES ('agent', 'Test agent')");
    await db.query("INSERT INTO channels (id, name, type, created_by, config) VALUES ('channel', 'Test bot', 'lark', 'owner', ?)",
      [JSON.stringify({ personal_bot: { agent_id: "agent", access_mode: "open" } })]);
    await db.query("INSERT INTO channel_bindings (id, channel_id, agent_id, route_key, route_type, session_id) VALUES ('binding', 'channel', 'agent', 'chat', 'group', 'legacy-old')");
    await db.query("INSERT INTO channel_binding_sessions (id, binding_id, session_key, session_id) VALUES ('one', 'binding', 'lark_thread:root', 'topic-old'), ('two', 'binding', 'lark_thread:other', 'other-topic'), ('dm', 'channel', 'open_id:person', 'dm-old')");
  });
  afterEach(closeDb);

  it.each([
    { method: "channel.resetPersonalSession", key: "open_id:person", old: "dm-old", binding: "channel" },
  ])("atomically consumes the expected session through $method ($key)", async ({ method, key, old, binding }) => {
    const reset = buildAdapterRpcHandlers().get(method)!;
    const params = { channel_id: "channel", route_key: "chat", session_key: key, expected_session_id: old };
    // Concurrent delivery of the same card can create only one new session.
    const results = await Promise.all([reset(params, "agent"), reset(params, "agent")]);
    const changed = results.filter(r => !r.unchanged);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ success: true, agentId: "agent", oldSessionId: old });
    expect(changed[0].sessionId).not.toBe(old);
    expect(results.find(r => r.unchanged)).toEqual({ success: true, unchanged: true });
    // Reconstructing the handlers has no effect on durable idempotence.
    expect(await buildAdapterRpcHandlers().get(method)!(params, "agent")).toEqual({ success: true, unchanged: true });
    const [current] = await getDb().query(key
      ? "SELECT session_id FROM channel_binding_sessions WHERE binding_id = ? AND session_key = ?"
      : "SELECT session_id FROM channel_bindings WHERE id = ?", key ? [binding, key] : [binding]);
    expect(current[0].session_id).toBe(changed[0].sessionId);
    const [other] = await getDb().query("SELECT session_id FROM channel_binding_sessions WHERE id = 'two'");
    expect(other[0].session_id).toBe("other-topic");
  });

  it.each(["", "lark_thread:root", "open_id:person"])("rejects legacy group card resets for session key %s", async (sessionKey) => {
    const reset = buildAdapterRpcHandlers().get("channel.resetSession")!;
    expect(await reset({ channel_id: "channel", route_key: "chat", session_key: sessionKey, expected_session_id: "topic-old" }, "agent"))
      .toMatchObject({ success: false });
    const [group] = await getDb().query("SELECT session_id FROM channel_bindings WHERE id = 'binding'");
    const [topic] = await getDb().query("SELECT session_id FROM channel_binding_sessions WHERE id = 'one'");
    expect(group[0].session_id).toBe("legacy-old");
    expect(topic[0].session_id).toBe("topic-old");
  });
});
