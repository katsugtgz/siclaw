import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SiticketClient } from "./client.js";
import type { SiticketConfig } from "./config.js";
import {
  getTicket,
  getTicketMessages,
  listTicketModules,
  TOOL_DEFINITIONS,
  viewTicketImage,
  type ToolContext,
} from "./tools.js";

export function createSiticketServer(config: SiticketConfig, fetchImpl?: typeof fetch): Server {
  const doFetch = fetchImpl ?? fetch;
  const ctx: ToolContext = {
    client: new SiticketClient(config, fetchImpl),
    pinnedTicketId: config.pinnedTicketId,
    seenImages: new Map(),
    // No Authorization header: the url is the object store's, and the Siticket
    // token must never leave for another host. A redirect could lead anywhere,
    // so it is refused rather than followed.
    fetchAttachment: (url, signal) => doFetch(url, { method: "GET", redirect: "error", signal }),
    requestTimeoutMs: config.requestTimeoutMs,
  };

  const server = new Server(
    { name: "mcp-siticket", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      let data: unknown;
      switch (request.params.name) {
        case "get_ticket":
          data = await getTicket(ctx, args);
          break;
        case "get_ticket_messages":
          data = await getTicketMessages(ctx, args);
          break;
        case "list_ticket_modules":
          data = await listTicketModules(ctx);
          break;
        case "view_ticket_image": {
          const image = await viewTicketImage(ctx, args);
          return {
            content: [
              { type: "text", text: JSON.stringify({ url: image.url, mime_type: image.mimeType, bytes: image.bytes }) },
              { type: "image", data: image.data, mimeType: image.mimeType },
            ],
          };
        }
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
            isError: true,
          };
      }
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (error) {
      // A read that failed must never look like a ticket with nothing in it.
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  return server;
}
