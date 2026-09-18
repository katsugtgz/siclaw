import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LIMITS, parseTicketClosureResult } from "./result.js";

export const TOOL_NAME = "submit_ticket_closure_result";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["description", "result_type", "result"],
  properties: {
    description: {
      type: "string",
      maxLength: LIMITS.descriptionMaxChars,
      description:
        "Ticket background: the customer's original need, the facts the conversation established, and the affected product module when it is known. State an unidentified module plainly instead of leaving it out or guessing one.",
    },
    result_type: {
      type: "string",
      maxLength: LIMITS.resultTypeMaxChars,
      description:
        "A short concrete category for this ticket's outcome — the fault type, or the consultation type. Free text, single line, no trailing punctuation. This is NOT the ticket's own classification, which the ticket already carries; and it must stay honest when the classification itself was never established.",
    },
    result: {
      type: "string",
      maxLength: LIMITS.resultMaxChars,
      description:
        "For a fault: the cause and the actions taken, with how the outcome was verified. For a consultation: the answer that was given. Where no cause was established, say so and describe what was actually observed — never supply a cause the conversation did not support, and never describe an action nobody took.",
    },
  },
} as const;

export function createTicketClosureResultServer(): Server {
  const server = new Server(
    { name: "mcp-ticket-closure-result", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Submit the closure summary for a ticket the customer resolved before any human handoff. Validates and returns the same three fields; it does not read or write the ticket system, close a ticket, or perform any other external side effect — the caller persists the result and owns the closure. Submit exactly one successful result per closure request; a rejected validation may be corrected and retried.",
        inputSchema,
        outputSchema: inputSchema,
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== TOOL_NAME) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }

    try {
      const result = parseTicketClosureResult(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Invalid ticket closure result: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
