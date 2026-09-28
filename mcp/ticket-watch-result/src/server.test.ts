import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createTicketWatchResultServer, TOOL_NAME } from "./server.js";
import { LIMITS, STATES } from "./result.js";

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createTicketWatchResultServer();
  const client = new Client({ name: "ticket-watch-result-test", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("ticket watch result MCP", () => {
  it("advertises one strict tool whose only required field is the state", async () => {
    await withClient(async (client) => {
      const response = await client.listTools();
      expect(response.tools.length).toBe(1);
      expect(response.tools[0]?.name).toBe(TOOL_NAME);
      expect(response.tools[0]?.inputSchema.additionalProperties).toBe(false);
      // Everything else is optional in the schema; the relationships that do
      // hold (a schedule unless done, a note when done) are enforced by the
      // parser, which can express them and JSON Schema here cannot.
      expect(response.tools[0]?.inputSchema.required).toEqual(["state"]);
      expect(response.tools[0]?.outputSchema).toEqual(response.tools[0]?.inputSchema);
    });
  });

  it("advertises the states and bounds the parser enforces", async () => {
    await withClient(async (client) => {
      const response = await client.listTools();
      const schema = response.tools[0]?.inputSchema as {
        properties?: Record<string, Record<string, unknown>>;
      };
      expect(schema.properties?.state?.enum).toEqual([...STATES]);
      expect(schema.properties?.state?.enum).not.toContain("stalled");
      expect(schema.properties?.next_check_after_seconds?.minimum).toBe(LIMITS.minCheckAfterSeconds);
      expect(schema.properties?.next_check_after_seconds?.maximum).toBe(LIMITS.maxCheckAfterSeconds);
      const understanding = schema.properties?.understanding as {
        additionalProperties?: boolean;
        properties?: Record<string, Record<string, unknown>>;
      };
      expect(understanding.additionalProperties).toBe(false);
      expect(Object.keys(understanding.properties ?? {})).toEqual([
        "timeline",
        "ruled_out",
        "open_questions",
        "from_l1",
      ]);
      const closure = schema.properties?.closure as {
        additionalProperties?: boolean;
        properties?: Record<string, Record<string, unknown>>;
      };
      expect(closure.additionalProperties).toBe(false);
      expect(Object.keys(closure.properties ?? {})).toEqual(["modules", "result_type", "result"]);
      expect((closure.properties?.modules?.items as { pattern?: string }).pattern).toBe("^[a-z][a-z0-9_-]*$");
      expect(closure.properties?.result_type?.maxLength).toBe(LIMITS.resultTypeMaxChars);
      expect(closure.properties?.result?.maxLength).toBe(LIMITS.resultMaxChars);
      const ruledOut = understanding.properties?.ruled_out as {
        items?: { required?: string[] };
      };
      expect(ruledOut.items?.required).toEqual(["claim", "by_task"]);
    });
  });

  it("accepts a turn that did nothing", async () => {
    await withClient(async (client) => {
      const response = await client.callTool(
        { name: TOOL_NAME, arguments: { state: "waiting_sre", next_check_after_seconds: 600 } },
        CallToolResultSchema,
      );
      expect(response.isError).toBeUndefined();
      expect(response.structuredContent).toEqual({
        state: "waiting_sre",
        next_check_after_seconds: 600,
      });
    });
  });

  it("returns canonical JSON as text and structured content", async () => {
    await withClient(async (client) => {
      const response = await client.callTool(
        {
          name: TOOL_NAME,
          arguments: {
            state: "watching",
            next_check_after_seconds: 300,
            last_seen_message_id: "1047",
            open_sre_tasks: ["task-abc"],
            understanding: {
              timeline: "  13:50 起海外 MaaS API 报 404，三次复现  ",
              ruled_out: [{ claim: "网关不健康", by_task: "task-abc" }],
              open_questions: ["客户用的是哪个模型，尚未说明"],
            },
            note: "已派排障任务 task-abc，等结果",
          },
        },
        CallToolResultSchema,
      );

      expect(response.isError).toBeUndefined();
      expect(response.structuredContent).toEqual({
        state: "watching",
        next_check_after_seconds: 300,
        last_seen_message_id: "1047",
        open_sre_tasks: ["task-abc"],
        understanding: {
          timeline: "13:50 起海外 MaaS API 报 404，三次复现",
          ruled_out: [{ claim: "网关不健康", by_task: "task-abc" }],
          open_questions: ["客户用的是哪个模型，尚未说明"],
        },
        note: "已派排障任务 task-abc，等结果",
      });
      const content = response.content as Array<{ type: string; text?: string }>;
      if (content[0]?.type !== "text" || content[0].text === undefined) {
        throw new Error("expected text content");
      }
      expect(JSON.parse(content[0].text)).toEqual(response.structuredContent);
    });
  });

  it("rejects an invalid result without structured content", async () => {
    await withClient(async (client) => {
      for (const args of [
        {},
        { state: "stalled", next_check_after_seconds: 300 },
        { state: "watching" },
        { state: "done", next_check_after_seconds: 300, note: "已结单" },
        { state: "done" },
        { state: "watching", next_check_after_seconds: 30 },
        {
          state: "watching",
          next_check_after_seconds: 300,
          understanding: { ruled_out: [{ claim: "网关不健康" }] },
        },
        { state: "watching", next_check_after_seconds: 300, reply_to_group: "已收到" },
      ]) {
        const response = await client.callTool({ name: TOOL_NAME, arguments: args }, CallToolResultSchema);
        expect(response.isError).toBe(true);
        expect(response.structuredContent).toBeUndefined();
      }
    });
  });

  it("rejects an unknown tool name", async () => {
    await withClient(async (client) => {
      const response = await client.callTool(
        { name: "submit_ticket_closure_result", arguments: {} },
        CallToolResultSchema,
      );
      expect(response.isError).toBe(true);
    });
  });
});
