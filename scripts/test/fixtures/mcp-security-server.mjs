import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ReadResourceRequestSchema, GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const secret = process.env.FIXTURE_SECRET ?? "security-fixture-secret";
if (process.env.START_FILE) fs.appendFileSync(process.env.START_FILE, "started\n");
const server = new Server({ name: `fixture-${secret}`, version: "1.0.0" }, { capabilities: { tools: {}, resources: {}, prompts: {} },
  instructions: `must-never-reach-model-${secret}` });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: "read_fixture", description: `read fixture ${secret}`, inputSchema: { type: "object", properties: { mode: { type: "string" }, label: { type: "string", default: secret } } } },
  { name: "write_fixture", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (process.env.COUNTER_FILE) fs.appendFileSync(process.env.COUNTER_FILE, request.params.name + "\n");
  if (request.params.name === "write_fixture") return { content: [{ type: "text", text: "mutated" }] };
  const mode = request.params.arguments?.mode;
  if (mode === "error") throw new Error(`Authorization: Bearer ${secret} body=${secret}`);
  if (mode === "oversized") return { content: [{ type: "text", text: secret.repeat(900_000) }] };
  if (mode === "wait") await new Promise(resolve => setTimeout(resolve, 60_000));
  return { content: [
    { type: "text", text: `plain ${secret}; encoded ${Buffer.from(secret).toString("base64")}` },
    { type: "text", text: JSON.stringify({ generic: secret, password: "tiny", healthy: true }) },
    { type: "resource", resource: { uri: "fixture://embedded", text: `embedded ${secret}` } },
    { type: "image", data: Buffer.from(secret).toString("base64"), mimeType: "image/png" },
    { type: "resource_link", uri: `https://fixture.invalid/${secret}`, name: secret },
  ], structuredContent: { unlabelled: secret, healthy: true }, _meta: { leaking: secret } };
});
server.setRequestHandler(ReadResourceRequestSchema, async request => {
  if (process.env.COUNTER_FILE) fs.appendFileSync(process.env.COUNTER_FILE, "resources/read\n");
  return { contents: [{ uri: request.params.uri, text: `resource ${secret}` }] };
});
server.setRequestHandler(GetPromptRequestSchema, async () => {
  if (process.env.COUNTER_FILE) fs.appendFileSync(process.env.COUNTER_FILE, "prompts/get\n");
  return { description: secret, messages: [{ role: "user", content: { type: "text", text: `prompt ${secret}` } }] };
});
await server.connect(new StdioServerTransport());
