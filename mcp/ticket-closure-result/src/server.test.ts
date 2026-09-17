import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createTicketClosureResultServer, TOOL_NAME } from "./server.js";

async function withClient(run: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createTicketClosureResultServer();
  const client = new Client({ name: "ticket-closure-result-test", version: "0.1.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("ticket closure result MCP", () => {
  it("advertises exactly one strict tool bounded like Siticket's form", async () => {
    await withClient(async (client) => {
      const response = await client.listTools();
      expect(response.tools.length).toBe(1);
      expect(response.tools[0]?.name).toBe(TOOL_NAME);
      expect(response.tools[0]?.inputSchema.additionalProperties).toBe(false);
      expect(response.tools[0]?.inputSchema.required).toEqual([
        "description",
        "result_type",
        "result",
      ]);
      const schema = response.tools[0]?.inputSchema as {
        properties?: Record<string, { maxLength?: number; enum?: string[] }>;
      };
      expect(schema.properties?.result_type?.maxLength).toBe(256);
      expect(schema.properties?.description?.maxLength).toBe(2000);
      expect(schema.properties?.result?.maxLength).toBe(4000);
      // result_type is free text on Siticket's side; advertising an enum here
      // would refuse values its own human form accepts.
      expect(schema.properties?.result_type?.enum).toBeUndefined();
      expect(response.tools[0]?.outputSchema).toEqual(response.tools[0]?.inputSchema);
    });
  });

  it("returns canonical JSON as text and structured content", async () => {
    await withClient(async (client) => {
      const response = await client.callTool(
        {
          name: TOOL_NAME,
          arguments: {
            description: "  用户询问项目配额是否独立计算。  ",
            result_type: "  配额口径咨询  ",
            result: "  依据配额文档说明每个项目独立享有三个实例，用户已确认解答。  ",
          },
        },
        CallToolResultSchema,
      );

      expect(response.isError).toBeUndefined();
      expect(response.structuredContent).toEqual({
        description: "用户询问项目配额是否独立计算。",
        result_type: "配额口径咨询",
        result: "依据配额文档说明每个项目独立享有三个实例，用户已确认解答。",
      });
      const content = response.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.type).toBe("text");
      if (content[0]?.type !== "text" || content[0].text === undefined) {
        throw new Error("expected text content");
      }
      expect(JSON.parse(content[0].text)).toEqual(response.structuredContent);
    });
  });

  it("rejects an invalid result without structured content", async () => {
    await withClient(async (client) => {
      for (const args of [
        { description: "背景", result_type: " ", result: "结果" },
        { description: "背景", result_type: "分类", result: "" },
        { description: "背景", result_type: "分\n类", result: "结果" },
        { description: "背景", result_type: "分类", result: "结果", extra: "x" },
        { description: "背景", result_type: "分类" },
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
        { name: "submit_product_support_result", arguments: {} },
        CallToolResultSchema,
      );
      expect(response.isError).toBe(true);
    });
  });
});
