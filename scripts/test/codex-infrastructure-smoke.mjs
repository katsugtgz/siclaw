// Official source-built exec-server + actual SSH protocol + real broker.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ssh2 from "ssh2";
import { WebSocket } from "ws";
import { CodexExecutorRelay } from "../../dist/core/brains/codex-executor-relay.js";
import { CredentialBroker } from "../../dist/agentbox/credential-broker.js";
import { setExtraCommands } from "../../dist/tools/infra/command-sets.js";
import { parseExtraCommandsConfig } from "../../dist/tools/infra/extra-commands.js";

assert.ok(process.env.SICLAW_CODEX_BIN, "Use the pinned source-built Codex binary");
const root = mkdtempSync(join(tmpdir(), "native-readonly-ssh-"));
const workspace = join(root, "workspace"); mkdirSync(workspace);
const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
let executions = 0, credentialRequests = 0, bound = true;
const server = new ssh2.Server({ hostKeys: [key] }, client => {
  client.on("authentication", context => context.method === "password" && context.username === "reader" &&
    context.password === "local-ssh-fixture" ? context.accept() : context.reject());
  client.on("ready", () => client.on("session", accept => {
    const session = accept();
    session.on("exec", (accept, _reject, info) => {
      assert.match(info.command, /'timeout'.*(?:uname|curl|sichek|printenv|mmlscluster)/);
      executions++;
      const stream = accept();
      stream.write("NATIVE_SSH_READ_OK\npassword: private-runtime-fixture\nOPENAI_API_KEY=private-env-fixture\n");
      stream.exit(0); stream.end();
    });
  }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const meta = { name: "fixture-host", ip: "127.0.0.1", port, username: "reader", auth_type: "password", is_production: false };
const broker = new CredentialBroker({ listClusters: async () => [], listHosts: async () => bound ? [meta] : [],
  queryHosts: async () => ({ hosts: [], total: 0, next_cursor: null }),
  getClusterCredential: async () => { throw Error("No cluster granted"); },
  getHostCredential: async name => {
    assert.ok(bound); assert.equal(name, "fixture-host"); credentialRequests++;
    return { credential: { name, type: "ssh", metadata: meta,
      files: [{ name: "host.password", content: "local-ssh-fixture" }] } };
  } }, join(root, "credentials"));
const relay = new CodexExecutorRelay({ executable: process.env.SICLAW_CODEX_BIN,
  home: join(root, "executor"), cwd: workspace, grants: { readRoots: [workspace], executionRoots: [workspace],
    writeRoots: [], deniedRoots: [], allowCommands: false, allowFileCommands: false, production: false,
    infrastructure: { kind: "ssh", broker } } });
let socket;
try {
  await relay.start();
  socket = new WebSocket(relay.url, { headers: { Authorization: `Bearer ${relay.bearerToken}` } });
  const pending = new Map(); const events = []; let id = 0;
  socket.on("message", raw => {
    const value = JSON.parse(raw.toString());
    if (value.id !== undefined) { pending.get(value.id)?.(value); pending.delete(value.id); }
    else events.push(value);
  });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id; const timer = setTimeout(() => reject(Error(`Native ${method} timeout`)), 20000);
    pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  assert.ok((await rpc("initialize", { clientName: "native-infrastructure-smoke" })).result);
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  const start = (processId, command) => rpc("process/start", { processId, argv: ["/bin/bash", "-c", command],
    cwd: pathToFileURL(workspace).href, env: { SSH_AUTH_SOCK: "/attacker" }, tty: false, pipeStdin: true });
  const extras = new URL("../../docker/extra-commands.json", import.meta.url);
  setExtraCommands(parseExtraCommandsConfig(readFileSync(extras, "utf8"), extras.pathname));
  for (const [processId, command] of [["safe", "uname -a"], ["curl", "curl -sS https://example.test/healthz"],
    ["extra", "sichek gpu"], ["vendor-path", "/usr/lpp/mmfs/bin/mmlscluster --ces"], ["env", "printenv"]]) {
    assert.ok((await start(processId, `ssh fixture-host -- ${command}`)).result);
    const deadline = Date.now() + 20000;
    while (!events.some(e => e.method === "process/exited" && e.params.processId === processId)) {
      assert.ok(Date.now() < deadline, `SSH ${processId} did not finish (executions=${executions}, credentials=${credentialRequests})`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(events.find(e => e.method === "process/exited" && e.params.processId === processId).params.exitCode, 0);
  }
  const text = events.filter(e => e.method === "process/output").map(e => Buffer.from(e.params.chunk, "base64").toString()).join("");
  assert.match(text, /NATIVE_SSH_READ_OK/);
  assert.ok(!text.includes("private-runtime-fixture")); assert.ok(!text.includes("private-env-fixture"));
  assert.equal(executions, 5); assert.equal(credentialRequests, 5);
  assert.ok((await start("write", "ssh fixture-host -- touch /tmp/owned")).error);
  assert.ok((await start("options", "ssh -i /tmp/key fixture-host -- uname")).error);
  assert.ok((await start("bad-curl", "ssh fixture-host -- curl -X POST https://example.test")).error);
  assert.ok((await start("bad-extra", "ssh fixture-host -- sichek daemon")).error);
  assert.ok((await start("untrusted-path", "ssh fixture-host -- /tmp/mmlscluster --ces")).error);
  setExtraCommands({});
  assert.ok((await start("removed-extra", "ssh fixture-host -- sichek gpu")).error);
  assert.equal(executions, 5);
  bound = false;
  assert.ok((await start("revoked", "ssh fixture-host -- uname")).result);
  const revokedDeadline = Date.now() + 20000;
  while (!events.some(e => e.method === "process/exited" && e.params.processId === "revoked")) {
    assert.ok(Date.now() < revokedDeadline); await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(executions, 5); assert.equal(credentialRequests, 5);
  assert.notEqual(events.find(e => e.method === "process/exited" && e.params.processId === "revoked").params.exitCode, 0);
  console.log("Native infrastructure smoke passed: official exec-server, shared whitelist/extras, broker SSH, write denial, sanitized IPC and revoked binding");
} finally {
  setExtraCommands({});
  socket?.close(); await relay.close(); broker.dispose(); await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
