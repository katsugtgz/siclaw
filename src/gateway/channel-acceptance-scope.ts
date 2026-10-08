/** Operator-only fence for an isolated channel acceptance Runtime. Unset in
 * normal deployments. This narrows transport reception, never grants access. */
export interface ChannelAcceptanceScope {
  agentId: string;
  groupIds: ReadonlySet<string>;
  probeNonce?: string;
}

export function parseChannelAcceptanceScope(value: string | undefined): ChannelAcceptanceScope | undefined {
  if (value === undefined || value === "") return undefined;
  let data: unknown;
  try { data = JSON.parse(value); } catch { throw new Error("Invalid channel acceptance scope"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid channel acceptance scope");
  const input = data as Record<string, unknown>;
  if (Object.keys(input).some(key => !["agent_id", "group_ids", "probe_nonce"].includes(key)) ||
      typeof input.agent_id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.agent_id) ||
      !Array.isArray(input.group_ids) || input.group_ids.length > 16 ||
      input.group_ids.some(id => typeof id !== "string" || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(id)) ||
      input.probe_nonce !== undefined && (typeof input.probe_nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(input.probe_nonce))) {
    throw new Error("Invalid channel acceptance scope");
  }
  return { agentId: input.agent_id, groupIds: new Set(input.group_ids as string[]), probeNonce: input.probe_nonce as string | undefined };
}

export function channelMatchesAcceptanceScope(channel: Record<string, any>, scope: ChannelAcceptanceScope): boolean {
  if (channel.type !== "lark") return false;
  let config = channel.config;
  if (typeof config === "string") {
    try { config = JSON.parse(config); } catch { return false; }
  }
  return config?.personal_bot?.agent_id === scope.agentId;
}

const safeChatId = (id: unknown): id is string => typeof id === "string" && /^oc_[A-Za-z0-9_-]{1,128}$/.test(id);

/** Fresh per-handler DM knowledge prevents group/unknown card callbacks from
 * bypassing the message fence. After restart, send a DM before old DM buttons. */
export class ChannelAcceptanceReception {
  private readonly privateChats = new Set<string>();
  constructor(private readonly scope: ChannelAcceptanceScope) {}

  allowsMessage(data: any): boolean {
    const message = data?.message;
    if (!safeChatId(message?.chat_id)) return false;
    if (message.chat_type === "p2p") {
      if (this.privateChats.size >= 256 && !this.privateChats.has(message.chat_id)) {
        this.privateChats.delete(this.privateChats.values().next().value!);
      }
      this.privateChats.add(message.chat_id);
      return true;
    }
    return message.chat_type === "group" && this.scope.groupIds.has(message.chat_id);
  }

  allowsCard(data: any): boolean {
    const id = data?.context?.open_chat_id;
    return safeChatId(id) && (this.privateChats.has(id) || this.scope.groupIds.has(id));
  }

  /** Locates a human-selected test group without authorizing, replying,
   * binding, persisting its message or executing any task in that group. */
  groupProbeCandidate(data: any): string | undefined {
    const message = data?.message;
    if (!this.scope.probeNonce || message?.chat_type !== "group" || !safeChatId(message.chat_id) ||
        message.message_type !== "text" || typeof message.content !== "string" || message.content.length > 4096) return;
    try {
      const content = JSON.parse(message.content);
      if (typeof content.text === "string" && content.text.replace(/@_user_\d+/g, "").trim() === this.scope.probeNonce) return message.chat_id;
    } catch { /* Invalid untrusted content is never a probe. */ }
  }
}
