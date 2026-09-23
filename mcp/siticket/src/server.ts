import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SiticketClient } from "./client.js";
import type { SiticketConfig } from "./config.js";
import {
  getTicket,
  getTicketMessages,
  listTicketModules,
  TOOL_DEFINITIONS,
  type ToolContext,
} from "./tools.js";

export function createSiticketServer(config: SiticketConfig, fetchImpl?: typeof fetch): Server {
  const ctx: ToolContext = {
    client: new SiticketClient(config, fetchImpl),
    pinnedTicketId: config.pinnedTicketId,
  };

  const server = new Server(
    { name: "mcp-siticket", version: "0.1.0" },
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
