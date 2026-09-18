import { describe, expect, it, vi } from "vitest";
import { SiticketClient } from "./client.js";
import type { SiticketConfig } from "./config.js";
import {
  annotateMessagePage,
  getTicket,
  getTicketMessages,
  listTicketModules,
  MESSAGE_LIMIT_DEFAULT,
  MESSAGE_LIMIT_MAX,
  resolveMessageLimit,
  resolveTicketId,
  TOOL_DEFINITIONS,
  UNOPENED_SESSION_NOTE,
  type ToolContext,
} from "./tools.js";

const config: SiticketConfig = {
  baseUrl: "https://ticket.example.com",
  token: "t",
  requestTimeoutMs: 5000,
};

function context(pinnedTicketId?: string): { ctx: ToolContext; calls: URL[] } {
  const calls: URL[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(new URL(url));
    return new Response(JSON.stringify({ code: 0, data: { ok: true } }));
  });
  return {
    ctx: { client: new SiticketClient(config, impl as unknown as typeof fetch), pinnedTicketId },
    calls,
  };
}

describe("resolveTicketId", () => {
  it("requires an explicit ticket when nothing is pinned", () => {
    expect(() => resolveTicketId(undefined, undefined)).toThrow(/ticket_id is required/);
    expect(() => resolveTicketId("  ", undefined)).toThrow(/ticket_id is required/);
    expect(resolveTicketId(" t-1 ", undefined)).toBe("t-1");
  });

  it("refuses any ticket other than the pinned one", () => {
    expect(resolveTicketId("t-1", "t-1")).toBe("t-1");
    expect(resolveTicketId(undefined, "t-1")).toBe("t-1");
    expect(() => resolveTicketId("t-2", "t-1")).toThrow(/may only read ticket t-1/);
  });
});

describe("resolveMessageLimit", () => {
  it("defaults, bounds and rejects non-integers", () => {
    expect(resolveMessageLimit(undefined)).toBe(MESSAGE_LIMIT_DEFAULT);
    expect(resolveMessageLimit(10)).toBe(10);
    expect(() => resolveMessageLimit(0)).toThrow();
    expect(() => resolveMessageLimit(MESSAGE_LIMIT_MAX + 1)).toThrow();
    expect(() => resolveMessageLimit(1.5)).toThrow();
  });
});

describe("tool calls", () => {
  it("reads one ticket by id", async () => {
    const { ctx, calls } = context();
    await getTicket(ctx, { ticket_id: "t-1" });
    expect(calls[0].pathname).toBe("/openapi/ticket/customer_im/get");
    expect(calls[0].searchParams.get("ticket_id")).toBe("t-1");
  });

  it("pages messages with the cursor the previous answer returned", async () => {
    const { ctx, calls } = context();
    await getTicketMessages(ctx, { ticket_id: "t-1", after_message_id: " 946 ", limit: 5 });
    expect(calls[0].pathname).toBe("/openapi/ticket/customer_im/chat-history");
    expect(calls[0].searchParams.get("after_message_id")).toBe("946");
    expect(calls[0].searchParams.get("limit")).toBe("5");
  });

  it("omits the cursor on the first page instead of sending an empty one", async () => {
    const { ctx, calls } = context();
    await getTicketMessages(ctx, { ticket_id: "t-1", after_message_id: "  " });
    expect(calls[0].searchParams.has("after_message_id")).toBe(false);
    expect(calls[0].searchParams.get("limit")).toBe(String(MESSAGE_LIMIT_DEFAULT));
  });

  it("refuses a message read outside the pinned ticket before any request is sent", async () => {
    const { ctx, calls } = context("t-1");
    await expect(getTicketMessages(ctx, { ticket_id: "t-2" })).rejects.toThrow(/may only read/);
    expect(calls).toHaveLength(0);
  });

  it("lists modules without taking any argument", async () => {
    const { ctx, calls } = context();
    await listTicketModules(ctx);
    expect(calls[0].pathname).toBe("/openapi/ticket_role/module/list");
    expect([...calls[0].searchParams.keys()]).toHaveLength(0);
  });
});

describe("annotateMessagePage", () => {
  it("says an unclaimed ticket is not an empty conversation", () => {
    const page = annotateMessagePage({ session_opened: false, messages: [], ticket_context: { title: "x" } }) as Record<string, unknown>;
    expect(page.reading_note).toBe(UNOPENED_SESSION_NOTE);
    expect(page.reading_note).toMatch(/not an empty conversation/);
    expect(page.messages).toEqual([]);
    expect(page.ticket_context).toEqual({ title: "x" });
  });

  it("stays out of the way once the group is open, including a genuinely quiet one", () => {
    const page = annotateMessagePage({ session_opened: true, messages: [] }) as Record<string, unknown>;
    expect(page.reading_note).toBeUndefined();
  });

  it("passes through anything that is not an object", () => {
    expect(annotateMessagePage(null)).toBeNull();
    expect(annotateMessagePage([1])).toEqual([1]);
  });
});

describe("tool definitions", () => {
  it("exposes exactly the three read tools, and none that enumerates tickets", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      "get_ticket",
      "get_ticket_messages",
      "list_ticket_modules",
    ]);
  });

  it("requires a ticket id on every per-ticket tool", () => {
    for (const tool of TOOL_DEFINITIONS) {
      if (tool.name === "list_ticket_modules") continue;
      expect(tool.inputSchema.required).toContain("ticket_id");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("warns that the conversation is a filtered subset, so gaps are not loss", () => {
    const messages = TOOL_DEFINITIONS.find((t) => t.name === "get_ticket_messages");
    expect(messages?.description).toMatch(/NOT the raw group transcript/);
  });

  it("states each endpoint's time notation, since the two disagree", () => {
    const ticket = TOOL_DEFINITIONS.find((t) => t.name === "get_ticket");
    const messages = TOOL_DEFINITIONS.find((t) => t.name === "get_ticket_messages");
    // The offset-less form reads as local time to everyone who sees it.
    expect(ticket?.description).toMatch(/WITHOUT an offset/);
    expect(ticket?.description).toMatch(/not local time/);
    expect(messages?.description).toMatch(/RFC3339 UTC/);
  });

  it("tells the reader how to separate the customer from an assistant's reply", () => {
    const messages = TOOL_DEFINITIONS.find((t) => t.name === "get_ticket_messages");
    expect(messages?.description).toMatch(/sender_role/);
    expect(messages?.description).toMatch(/your own earlier reply as new evidence/);
  });

  it("carries the backoff and unclaimed rules where the caller will read them", () => {
    const messages = TOOL_DEFINITIONS.find((t) => t.name === "get_ticket_messages");
    expect(messages?.description).toMatch(/back off exponentially/);
    expect(messages?.description).toMatch(/session_opened false/);
  });

  it("allows the upstream maximum page size", () => {
    expect(MESSAGE_LIMIT_MAX).toBe(500);
    expect(resolveMessageLimit(500)).toBe(500);
    expect(() => resolveMessageLimit(501)).toThrow();
  });
});
