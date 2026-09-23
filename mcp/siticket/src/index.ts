#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createSiticketServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createSiticketServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const scope = config.pinnedTicketId ? ` ticket=${config.pinnedTicketId}` : "";
  process.stderr.write(`[mcp-siticket] ready${scope}\n`);
}

main().catch((error) => {
  // A configuration mistake is the operator's to fix and its message is safe to
  // print; anything else may carry request detail, so only the stack goes out.
  const detail =
    error instanceof ConfigError
      ? error.message
      : error instanceof Error
        ? error.stack
        : String(error);
  process.stderr.write(`[mcp-siticket] fatal: ${detail}\n`);
  process.exit(1);
});
