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

/**
 * The image formats the runtime hands to the model (src/core/mcp-client.ts).
 * SVG is left out on purpose: it is a document that happens to render, not a
 * picture, and nothing a customer pastes into a group needs it.
 */
export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
/** The runtime's own cap on one inbound image (image-url-ingest.ts). */
export const IMAGE_MAX_BYTES = 6 * 1024 * 1024;

export interface ToolContext {
  client: SiticketClient;
  pinnedTicketId?: string;
  /**
   * Image attachment urls get_ticket_messages returned, per ticket. They are
   * the only urls view_ticket_image fetches: an address the model read in a
   * message's text, or made up, is never requested.
   */
  seenImages?: Map<string, Set<string>>;
  /**
   * Fetches an attachment. It must not carry the Siticket token: the url points
   * at the object store, not at Siticket. Without one, images cannot be viewed.
   */
  fetchAttachment?: (url: string, signal: AbortSignal) => Promise<Response>;
  requestTimeoutMs?: number;
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
  recordImages(ctx, ticketId, page);
  return annotateMessagePage(page);
}

/** Remembers the image attachments of a page, as Siticket returned them. */
function recordImages(ctx: ToolContext, ticketId: string, page: unknown): void {
  if (!ctx.seenImages || page === null || typeof page !== "object") return;
  const messages = (page as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    const attachments = (message as { attachments?: unknown } | null)?.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const attachment of attachments) {
      const { type, url } = (attachment ?? {}) as { type?: unknown; url?: unknown };
      if (type !== "image" || typeof url !== "string" || !url) continue;
      let seen = ctx.seenImages.get(ticketId);
      if (!seen) {
        seen = new Set();
        ctx.seenImages.set(ticketId, seen);
      }
      seen.add(url);
    }
  }
}

export interface ViewedImage {
  url: string;
  mimeType: string;
  bytes: number;
  data: string;
}

/**
 * Fetches one image attachment of the ticket's conversation for the model to
 * look at: a customer's screenshot of an error is often the only exact record
 * of it. Only urls get_ticket_messages returned for this ticket are fetched, a
 * redirect is refused rather than followed, and the body is read against the
 * size cap as it arrives, so a missing or false Content-Length cannot make the
 * process buffer more than the cap.
 */
export async function viewTicketImage(ctx: ToolContext, args: Record<string, unknown>): Promise<ViewedImage> {
  const ticketId = resolveTicketId(args.ticket_id, ctx.pinnedTicketId);
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (!url) throw new SiticketError("url is required");
  if (!ctx.fetchAttachment || !ctx.seenImages) {
    throw new SiticketError("Viewing images is not available in this session");
  }
  if (!ctx.seenImages.get(ticketId)?.has(url)) {
    throw new SiticketError(
      "Only an image attachment that get_ticket_messages returned for this ticket can be viewed. " +
        "Read the messages first, and pass the attachment's url exactly as it was returned.",
    );
  }
  if (!/^https?:\/\//i.test(url)) throw new SiticketError("The attachment url is not an http(s) address");

  const controller = new AbortController();
  const timeoutMs = ctx.requestTimeoutMs ?? 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await ctx.fetchAttachment(url, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new SiticketError(`The image did not arrive within ${timeoutMs}ms`);
      throw new SiticketError(`The image could not be fetched: ${(error as Error).message}`);
    }
    if (!response.ok) throw new SiticketError(`The image could not be fetched (HTTP ${response.status})`);
    const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(mimeType)) {
      throw new SiticketError(`This attachment is ${mimeType || "of an unknown type"}, not an image that can be viewed`);
    }
    const tooLarge = () =>
      new SiticketError(`The image is larger than ${IMAGE_MAX_BYTES / (1024 * 1024)} MB and was not fetched`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) throw tooLarge();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > IMAGE_MAX_BYTES) {
          await reader.cancel();
          throw tooLarge();
        }
        chunks.push(value);
      }
    }
    return { url, mimeType, bytes, data: Buffer.concat(chunks).toString("base64") };
  } catch (error) {
    if (error instanceof SiticketError) throw error;
    if (controller.signal.aborted) throw new SiticketError(`The image did not arrive within ${timeoutMs}ms`);
    throw new SiticketError(`The image could not be read: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
    // A refused response still has its body streaming: without this the
    // connection keeps downloading the object after the call has returned.
    // After a complete read there is nothing left to cancel.
    controller.abort();
  }
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
    name: "view_ticket_image",
    description:
      "Look at an image posted in the ticket's conversation — a screenshot of an error, a console, a monitoring chart. Pass the url of an attachment whose type is image, exactly as get_ticket_messages returned it for this ticket; any other url is refused, so read the messages first. Returns the image itself. Only PNG, JPEG and WebP up to 6 MB can be viewed; logs, archives and other files cannot be opened here. Looking costs time and context, so open an image when what it shows matters to the ticket, not every image by default.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "string", description: "The ticket whose conversation the image was posted in." },
        url: { type: "string", description: "The image attachment's url, exactly as get_ticket_messages returned it." },
      },
      required: ["ticket_id", "url"],
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
