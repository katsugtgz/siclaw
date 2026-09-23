#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTicketWatchResultServer } from "./server.js";

async function main(): Promise<void> {
  const server = createTicketWatchResultServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp-ticket-watch-result] ready\n");
}

main().catch((error) => {
  process.stderr.write(
    `[mcp-ticket-watch-result] fatal: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
