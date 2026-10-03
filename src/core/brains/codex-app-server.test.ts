import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServer } from "./codex-app-server.js";

describe("CodexAppServer", () => {
  it("notifies the brain when the child exits after initialization", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-codex-exit-"));
    const executable = path.join(dir, "codex-fixture");
    fs.writeFileSync(executable, `#!${process.execPath}\n` +
      `process.stdin.setEncoding("utf8");\n` +
      `process.stdin.on("data", chunk => { for (const line of chunk.trim().split("\\n")) {\n` +
      `  const message = JSON.parse(line);\n` +
      `  if (message.method === "initialize") {\n` +
      `    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");\n` +
      `    setTimeout(() => process.exit(42), 20);\n` +
      `  }\n` +
      `} });\n`, { mode: 0o755 });
    const client = new CodexAppServer(dir, {}, executable);
    try {
      const failure = new Promise<Error>((resolve) => client.onFailure(resolve));
      await client.start();
      await expect(failure).resolves.toMatchObject({ message: expect.stringContaining("exited (42)") });
    } finally {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
