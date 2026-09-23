import type { SiticketClient } from "./client.js";
import { REQUESTS_PER_MINUTE, SiticketError } from "./client.js";

/**
 * Siticket accepts 1..500 and defaults to 100. The maximum matches it so a
 * caller that wants one big page is not refused here; the default is smaller
 * because an agent following a live ticket re-reads often and rarely needs a
 * hundred messages to decide what changed.
 */
export const MESSAGE_LIMIT_DEFAULT = 50;
export const MESSAGE_LIMIT_MAX = 500;

export interface ToolContext {
  client: SiticketClient;
  pinnedTicketId?: string;
}

/**
 * Two rules bound what a session reads, and only the second needs code here.
 *
 * 1. No tool enumerates tickets, so there is no listing to walk.
 * 2. When the deployment pins a ticket, any other id is refused outright.
 *
 * Rule 1 is not isolation: an unpinned process reads any ticket the token can
 * see once it has an id, including one it found in a ticket's own text. Only
 * the pin confines a process to one ticket.
 */
export function resolveTicketId(requested: unknown, pinned: string | undefined): string {
  const value = typeof requested === "string" ? requested.trim() : "";
  if (!value) {
    if (pinned) return pinned;
    throw new SiticketError("ticket_id is required");
  }
  if (pinned && value !== pinned) {
    throw new SiticketError(`This session may only read ticket ${pinned}`);
  }
  return value;
}

export function resolveMessageLimit(requested: unknown): number {
  if (requested === undefined || requested === null) return MESSAGE_LIMIT_DEFAULT;
  const value = Number(requested);
  if (!Number.isInteger(value) || value < 1 || value > MESSAGE_LIMIT_MAX) {
    throw new SiticketError(`limit must be an integer between 1 and ${MESSAGE_LIMIT_MAX}`);
  }
  return value;
}

export async function getTicket(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const ticketId = resolveTicketId(args.ticket_id, ctx.pinnedTicketId);
  return ctx.client.get("/openapi/ticket/customer_im/get", { ticket_id: ticketId });
}

/**
 * An unclaimed ticket is answered with HTTP 200, an empty message list and a
 * populated ticket_context — the same shape as a claimed ticket nobody has
 * written in yet. Those two mean opposite things to an agent deciding whether
 * it has seen the conversation, and nothing in the payload says which one it is
 * holding, so this adds the sentence. The field is ours, not Siticket's.
 */
export const UNOPENED_SESSION_NOTE =
  "This ticket has no processing group open yet, so Siticket returned no messages. " +
  "That is not an empty conversation: nothing has been said HERE YET because the ticket " +
  "has not been claimed. ticket_context below is complete and is the only material available. " +
  "Do not conclude that the customer said nothing.";

export function annotateMessagePage(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const page = payload as Record<string, unknown>;
  if (page.session_opened === false) {
    return { ...page, reading_note: UNOPENED_SESSION_NOTE };
  }
  return page;
}

export async function getTicketMessages(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const ticketId = resolveTicketId(args.ticket_id, ctx.pinnedTicketId);
  const limit = resolveMessageLimit(args.limit);
  const after =
    typeof args.after_message_id === "string" && args.after_message_id.trim()
      ? args.after_message_id.trim()
      : undefined;
  const page = await ctx.client.get("/openapi/ticket/customer_im/chat-history", {
    ticket_id: ticketId,
    limit,
    after_message_id: after,
  });
  return annotateMessagePage(page);
}

export async function listTicketModules(ctx: ToolContext): Promise<unknown> {
  return ctx.client.get("/openapi/ticket_role/module/list");
}

export const TOOL_DEFINITIONS = [
  {
    name: "get_ticket",
    description:
      "Read one ticket's current record: status, title, the customer's original query, the accumulated description, handlers, reviewers, watchers, the closing result and result type, the customer and processing group ids, and the start/finish/end timestamps. This is the ticket as the console shows it, and it is the only place the group ids and the reviewer list appear — the message reader's ticket_context carries a smaller subset. TIME: start_time, finish_time and end_time are UTC written WITHOUT an offset, e.g. \"2026-09-16 06:07:14\" means 06:07:14 UTC. They are not local time; reading them as UTC+8 shifts every ticket by eight hours. get_ticket_messages timestamps are RFC3339 with a Z, so both describe the same clock in different notation.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string", description: "The ticket to read, e.g. t-202609161407v92." },
      },
      required: ["ticket_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_ticket_messages",
    description:
      "Read the conversation attached to a ticket, oldest first. This is NOT the raw group transcript: Siticket returns the subset it considers readable for this ticket, so message ids are not contiguous and earlier ids may be absent by design. Page with after_message_id using next_after_message_id from the previous answer while has_more is true. Each message carries sender_name, sender_role (customer / staff / simulator / group_member / knowledge_agent), source (feishu_group / siticket_console / knowledge_agent), sent_at, content_type, content, attachments and reply_to_message_id — use sender_role to tell what the customer said from what an assistant already answered, rather than treating your own earlier reply as new evidence. Reading rules: a successful answer always carries the complete history up to its cursor, so history_complete is never partially true; session_opened false means the ticket has no processing group yet and a reading_note says so; and a retryable failure means Siticket is still syncing, not that anything is wrong with the ticket — back off exponentially instead of retrying at once. TIME: sent_at and edited_at are RFC3339 UTC (with Z), unlike get_ticket's offset-less timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string", description: "The ticket whose conversation to read." },
        after_message_id: {
          type: "string",
          description:
            "Return only messages after this id. Pass next_after_message_id from the previous page; omit for the first page.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MESSAGE_LIMIT_MAX,
          description: `Messages per page (default ${MESSAGE_LIMIT_DEFAULT}, maximum ${MESSAGE_LIMIT_MAX}). Siticket allows about ${REQUESTS_PER_MINUTE} requests per minute per token, so prefer a larger page over many small ones when catching up on a long conversation.`,
        },
      },
      required: ["ticket_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_ticket_modules",
    description:
      "List every product module Siticket routes on, as a flat table of about 73 rows: primary_product / secondary_system / tertiary_component with the owners of each level, plus l2_support, l3_owner, major_incident_lead and incident_decision_maker. The whole table is returned because deciding which module a symptom belongs to is a judgement about wording, not a lookup — read it and match the meaning. Owners are internal nicknames, not usernames or email addresses, so they identify who is responsible without being addressable.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;
