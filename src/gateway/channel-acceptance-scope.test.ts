import { describe, expect, it } from "vitest";
import { ChannelAcceptanceReception, channelMatchesAcceptanceScope, parseChannelAcceptanceScope } from "./channel-acceptance-scope.js";

const agentId = "79068105-473b-4417-8935-b4f11c16c5b3";
const value = { agent_id: agentId, group_ids: ["oc_test"], probe_nonce: "SICLAW_GROUP_PROBE_61F2" };
const scope = () => parseChannelAcceptanceScope(JSON.stringify(value))!;
const event = (chat_type: string, chat_id: string, text = "hello") => ({ message: { chat_type, chat_id, message_type: "text", content: JSON.stringify({ text }) } });

describe("operator-only channel acceptance scope", () => {
  it("does not change normal deployments when absent", () => {
    expect(parseChannelAcceptanceScope(undefined)).toBeUndefined();
    expect(parseChannelAcceptanceScope("")).toBeUndefined();
  });
  it.each(["not-json", "null", "[]", JSON.stringify({ ...value, agent_id: "other" }), JSON.stringify({ ...value, group_ids: ["*"] }),
    JSON.stringify({ ...value, group_ids: null }), JSON.stringify({ ...value, app_secret: "must-not-echo" })])("fails closed for malformed scope", raw => {
    expect(() => parseChannelAcceptanceScope(raw)).toThrow("Invalid channel acceptance scope");
  });
  it("selects only the named personal bot, not global or other Agent apps", () => {
    expect(channelMatchesAcceptanceScope({ type: "lark", config: { personal_bot: { agent_id: agentId } } }, scope())).toBe(true);
    expect(channelMatchesAcceptanceScope({ type: "lark", config: JSON.stringify({ personal_bot: { agent_id: agentId } }) }, scope())).toBe(true);
    for (const config of [{}, { personal_bot: { agent_id: "other" } }, "bad-json"]) expect(channelMatchesAcceptanceScope({ type: "lark", config }, scope())).toBe(false);
    expect(channelMatchesAcceptanceScope({ type: "dingtalk", config: { personal_bot: { agent_id: agentId } } }, scope())).toBe(false);
  });
  it("allows private chat and only the exact named group, never unknown types", () => {
    const reception = new ChannelAcceptanceReception(scope());
    expect(reception.allowsMessage(event("p2p", "oc_dm"))).toBe(true);
    expect(reception.allowsMessage(event("group", "oc_test"))).toBe(true);
    expect(reception.allowsMessage(event("group", "oc_other"))).toBe(false);
    expect(reception.allowsMessage(event("unknown", "oc_test"))).toBe(false);
    expect(reception.allowsMessage(event("p2p", "injected\nchat"))).toBe(false);
  });
  it("fences cards to selected groups and DMs actually observed by this handler", () => {
    const reception = new ChannelAcceptanceReception(scope());
    const card = (id: string) => ({ context: { open_chat_id: id } });
    expect(reception.allowsCard(card("oc_test"))).toBe(true);
    expect(reception.allowsCard(card("oc_dm"))).toBe(false);
    reception.allowsMessage(event("p2p", "oc_dm"));
    expect(reception.allowsCard(card("oc_dm"))).toBe(true);
    expect(reception.allowsCard(card("oc_other"))).toBe(false);
    expect(reception.allowsCard({})).toBe(false);
    expect(new ChannelAcceptanceReception(scope()).allowsCard(card("oc_dm"))).toBe(false);
  });
  it("a group probe reports metadata but never grants routing or card authority", () => {
    const reception = new ChannelAcceptanceReception(scope());
    const probe = event("group", "oc_candidate", "@_user_1 " + value.probe_nonce);
    expect(reception.groupProbeCandidate(probe)).toBe("oc_candidate");
    expect(reception.allowsMessage(probe)).toBe(false);
    expect(reception.allowsCard({ context: { open_chat_id: "oc_candidate" } })).toBe(false);
    expect(reception.groupProbeCandidate(event("group", "oc_candidate", "unrelated"))).toBeUndefined();
    expect(reception.groupProbeCandidate(event("p2p", "oc_candidate", value.probe_nonce))).toBeUndefined();
  });
});
