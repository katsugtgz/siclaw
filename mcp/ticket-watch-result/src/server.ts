import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LIMITS, parseTicketWatchResult, STATES } from "./result.js";

export const TOOL_NAME = "submit_ticket_watch_result";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["state"],
  properties: {
    state: {
      type: "string",
      enum: [...STATES],
      description:
        'Where this follow stands now. "watching" — actively looking. "waiting_sre" — an investigation is running and its result is what comes next. "waiting_l1" — a person has to act before anything moves. "done" — the follow is over. There is no state for "stuck": that is the harness\'s verdict after repeated failures, not yours.',
    },
    next_check_after_seconds: {
      type: "integer",
      minimum: LIMITS.minCheckAfterSeconds,
      maximum: LIMITS.maxCheckAfterSeconds,
      description:
        "How long until you should be woken again. Required unless state is \"done\", where it must be omitted. This is a floor, not a promise: a message from a person or a finished investigation wakes you sooner. Choose it by how fast this ticket is actually moving — a long wait costs nothing when a real signal will pull you forward.",
    },
    last_seen_message_id: {
      type: "string",
      maxLength: LIMITS.idMaxChars,
      description:
        "The last group message you read. Omit it if you read nothing new; the stored cursor then stays where it was and you will see the same messages again.",
    },
    open_sre_tasks: {
      type: "array",
      maxItems: LIMITS.maxOpenTasks,
      items: { type: "string", maxLength: LIMITS.idMaxChars },
      description:
        "Investigation task ids still in flight, as the complete list. Send [] when none are. Omit the field to leave the stored list untouched.",
    },
    understanding: {
      type: "object",
      additionalProperties: false,
      description:
        "What you want the next run to know — it is handed exactly this and nothing else, possibly in a fresh session two days from now. Each field you send REPLACES that field; each field you omit is left alone. Rewrite rather than append: the space is deliberately small so it stays readable as the ticket ages.",
      properties: {
        timeline: {
          type: "string",
          maxLength: LIMITS.timelineMaxChars,
          description:
            "What happened, in order, as established facts: symptom, when it started, scope, what changed. Not a transcript and not your guesses.",
        },
        ruled_out: {
          type: "array",
          maxItems: LIMITS.maxListItems,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["claim", "by_task"],
            properties: {
              claim: {
                type: "string",
                maxLength: LIMITS.claimMaxChars,
                description: "The cause that was excluded.",
              },
              by_task: {
                type: "string",
                maxLength: LIMITS.idMaxChars,
                description: "The investigation task id that excluded it.",
              },
            },
          },
          description:
            "Causes an investigation has excluded, each with the task that did it. You may not rule anything out on your own reading — that belongs in open_questions. A wrong exclusion here is worse than a missing one: whoever reads it next cannot see where it came from and has no reason to doubt it.",
        },
        open_questions: {
          type: "array",
          maxItems: LIMITS.maxListItems,
          items: { type: "string", maxLength: LIMITS.listItemMaxChars },
          description:
            "What is still unknown, including anything you suspect but have not established. Suspicions live here, never in ruled_out or timeline.",
        },
        from_l1: {
          type: "array",
          maxItems: LIMITS.maxListItems,
          items: { type: "string", maxLength: LIMITS.listItemMaxChars },
          description:
            "What the L1 engineer told you that should outlive this run — context, priorities, instructions. Keep it as what they said, not as your conclusion from it.",
        },
      },
    },
    note: {
      type: "string",
      maxLength: LIMITS.noteMaxChars,
      description:
        "One line about THIS run for whoever reads the trail later: what you did, or why you did nothing. Internal to the team — it never reaches the ticket, the group or the customer. Required when state is \"done\", to say why the follow ended.",
    },
  },
} as const;

export function createTicketWatchResultServer(): Server {
  const server = new Server(
    { name: "mcp-ticket-watch-result", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL_NAME,
        description:
          "Close out this turn of following a ticket: where the follow stands, when to wake you next, and what the next run should know. Call it exactly once, last. It validates and returns what you submitted; it does not read or write the ticket, message anyone, or start anything — the harness stores the result and acts on it. A turn in which nothing happened is a normal result: submit the state and the next check, omit everything else, and nothing stored changes.",
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
      const result = parseTicketWatchResult(request.params.arguments ?? {});
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Invalid ticket watch result: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
