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
  IMAGE_MAX_BYTES,
  TOOL_DEFINITIONS,
  UNOPENED_SESSION_NOTE,
  viewTicketImage,
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
  it("exposes exactly the read tools, and none that enumerates tickets", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      "get_ticket",
      "get_ticket_messages",
      "view_ticket_image",
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

describe("view_ticket_image", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const IMAGE_URL = "https://oss.example/bucket/session_resources/1/a.png";

  function imageContext(respond: (url: string, init: RequestInit) => Response, pinned?: string) {
    const siticket = vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { messages: [
        { message_id: "101", sender_role: "customer", content: "报错截图 [图片] https://elsewhere.example/x.png",
          attachments: [
            { type: "image", url: IMAGE_URL, content_type: "image/png" },
            { type: "file", url: "https://oss.example/bucket/session_resources/1/b.zip", name: "log.zip" },
          ] },
      ] } })),
    );
    const fetched: { url: string; init: RequestInit }[] = [];
    const ctx: ToolContext = {
      client: new SiticketClient(config, siticket as unknown as typeof fetch),
      pinnedTicketId: pinned,
      seenImages: new Map(),
      fetchAttachment: async (url, signal) => {
        const init = { method: "GET", redirect: "error" as const, signal };
        fetched.push({ url, init });
        return respond(url, init);
      },
      requestTimeoutMs: 1000,
    };
    return { ctx, fetched };
  }

  const png = () => new Response(PNG, { headers: { "content-type": "image/png" } });

  it("fetches an image the conversation returned, and returns it as data", async () => {
    const { ctx, fetched } = imageContext(png);
    await getTicketMessages(ctx, { ticket_id: "t-1" });
    const image = await viewTicketImage(ctx, { ticket_id: "t-1", url: IMAGE_URL });
    expect(image).toMatchObject({ url: IMAGE_URL, mimeType: "image/png", bytes: PNG.length });
    expect(Buffer.from(image.data, "base64")).toEqual(Buffer.from(PNG));
    expect(fetched).toHaveLength(1);
    // The object store is not Siticket: its token must not travel there.
    expect(new Headers(fetched[0].init.headers).has("authorization")).toBe(false);
  });

  it("refuses a url the conversation did not return as an image attachment", async () => {
    const { ctx, fetched } = imageContext(png);
    await expect(viewTicketImage(ctx, { ticket_id: "t-1", url: IMAGE_URL })).rejects.toThrow(/Read the messages first/);
    await getTicketMessages(ctx, { ticket_id: "t-1" });
    // Written in a message's text, or a non-image attachment: never fetched.
    await expect(viewTicketImage(ctx, { ticket_id: "t-1", url: "https://elsewhere.example/x.png" })).rejects.toThrow(/Read the messages first/);
    await expect(viewTicketImage(ctx, { ticket_id: "t-1", url: "https://oss.example/bucket/session_resources/1/b.zip" })).rejects.toThrow(/Read the messages first/);
    // Another ticket's conversation does not open this one's images.
    await expect(viewTicketImage(ctx, { ticket_id: "t-2", url: IMAGE_URL })).rejects.toThrow(/Read the messages first/);
    expect(fetched).toHaveLength(0);
  });

  it("keeps a pinned session to its own ticket", async () => {
    const { ctx } = imageContext(png, "t-1");
    await expect(viewTicketImage(ctx, { ticket_id: "t-2", url: IMAGE_URL })).rejects.toThrow(/may only read ticket t-1/);
  });

  it("opens only the image types the runtime passes to the model", async () => {
    for (const type of ["image/svg+xml", "image/gif", "text/html", ""]) {
      const { ctx } = imageContext(() => new Response("x", { headers: type ? { "content-type": type } : {} }));
      await getTicketMessages(ctx, { ticket_id: "t-1" });
      await expect(viewTicketImage(ctx, { ticket_id: "t-1", url: IMAGE_URL })).rejects.toThrow(/not an image that can be viewed/);
    }
  });

  it("stops at the size cap whether or not the length was declared", async () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    const declared = imageContext(() => new Response(big, { headers: { "content-type": "image/png", "content-length": String(big.length) } }));
    await getTicketMessages(declared.ctx, { ticket_id: "t-1" });
    await expect(viewTicketImage(declared.ctx, { ticket_id: "t-1", url: IMAGE_URL })).rejects.toThrow(/larger than 6 MB/);

    const undeclared = imageContext(() => {
      const chunk = new Uint8Array(1024 * 1024);
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += chunk.length;
          if (sent > IMAGE_MAX_BYTES + chunk.length) controller.close();
          else controller.enqueue(chunk);
        },
      });
      return new Response(body, { headers: { "content-type": "image/jpeg" } });
    });
    await getTicketMessages(undeclared.ctx, { ticket_id: "t-1" });
    await expect(viewTicketImage(undeclared.ctx, { ticket_id: "t-1", url: IMAGE_URL })).rejects.toThrow(/larger than 6 MB/);
  });

  it("cancels the download whenever it refuses the response", async () => {
    // An abandoned response keeps its connection streaming the rest of the
    // object, and the timeout is cleared on the way out, so nothing else stops it.
    const refusals: [string, () => Response][] = [
      ["HTTP 403", () => new Response("denied", { status: 403 })],
      ["not an image that can be viewed", () => new Response("<html>", { headers: { "content-type": "text/html" } })],
      ["larger than 6 MB", () => new Response("x", { headers: { "content-type": "image/png", "content-length": String(IMAGE_MAX_BYTES + 1) } })],
    ];
    for (const [reason, respond] of refusals) {
      const { ctx, fetched } = imageContext(respond);
      await getTicketMessages(ctx, { ticket_id: "t-1" });
      await expect(viewTicketImage(ctx, { ticket_id: "t-1", url: IMAGE_URL })).rejects.toThrow(reason);
      expect(fetched[0].init.signal?.aborted, reason).toBe(true);
    }
  });

  it("reports a failed fetch as a failure, never as an empty image", async () => {
    const { ctx } = imageContext(() => new Response("gone", { status: 404 }));
    await getTicketMessages(ctx, { ticket_id: "t-1" });
    await expect(viewTicketImage(ctx, { ticket_id: "t-1", url: IMAGE_URL })).rejects.toThrow(/HTTP 404/);
  });
});

