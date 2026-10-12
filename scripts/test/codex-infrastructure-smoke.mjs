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
let executions = 0, resolutions = 0, credentialRequests = 0, bound = true;
let remoteActive = false, remoteReaps = 0;
let remoteStream;
const server = new ssh2.Server({ hostKeys: [key] }, client => {
  client.on("authentication", context => context.method === "password" && context.username === "reader" &&
    context.password === "local-ssh-fixture" ? context.accept() : context.reject());
  client.on("ready", () => client.on("session", accept => {
    const session = accept();
    session.on("exec", (accept, _reject, info) => {
      if (info.command.includes("pkill -TERM -s")) {
        assert.match(info.command, /\/tmp\/siclaw-bg-native-remote-[a-f0-9]+\.pgid/);
        remoteReaps++; remoteActive = false;
        if (remoteStream && !remoteStream.destroyed) { remoteStream.exit(143); remoteStream.end(); }
        const stream = accept(); stream.exit(0); stream.end(); return;
      }
      if (info.command.includes("sleep") && info.command.includes("197")) {
        executions++; remoteActive = true;
        const stream = accept(); remoteStream = stream; stream.write("REMOTE_CANCEL_STARTED\n");
        // Channel close does not reap a non-PTY remote process. Only the fresh
        // owned-session cleanup above may clear remoteActive in this fixture.
        return;
      }
      if (info.command.includes("crictl pods")) {
        assert.ok(info.command.includes('crictl pods --name "^rdma-a$" --namespace "^test$"'));
        resolutions++;
        const stream = accept();
        stream.write(JSON.stringify({ info: { runtimeSpec: { linux: { namespaces: [{ type: "network", path: "/var/run/netns/cni-protocol-fixture" }] } } } }));
        stream.exit(0); stream.end(); return;
      }
      assert.match(info.command, /(?:uname|curl|sichek|printenv|mmlscluster|show_gids)/);
      if (info.command.includes("show_gids")) {
        assert.match(info.command, /ip netns exec/); assert.match(info.command, /cni-protocol-fixture/);
      }
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
    ["extra", "sichek gpu"], ["vendor-path", "/usr/lpp/mmfs/bin/mmlscluster --ces"], ["env", "printenv"], ["netns", "show_gids"]]) {
    assert.ok((await start(processId, `ssh fixture-host ${processId === "netns" ? "--pod rdma-a --namespace test " : ""}-- ${command}`)).result);
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
  assert.equal(executions, 6); assert.equal(credentialRequests, 6); assert.equal(resolutions, 1);
  assert.ok((await start("cancel", "ssh fixture-host --pod rdma-a --namespace test -- sleep 197")).result);
  const startedDeadline = Date.now() + 20000;
  while (!remoteActive) { assert.ok(Date.now() < startedDeadline); await new Promise(resolve => setTimeout(resolve, 50)); }
  relay.cancelProcesses(); // Same product Stop boundary used by CodexAgentBrain.
  const reapedDeadline = Date.now() + 20000;
  while (remoteActive) { assert.ok(Date.now() < reapedDeadline, "Native termination left remote work alive"); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(remoteReaps >= 1);
  while (!events.some(event => event.method === "process/exited" && event.params.processId === "cancel")) {
    assert.ok(Date.now() < reapedDeadline, "Stopped transport stayed active"); await new Promise(resolve => setTimeout(resolve, 50));
  }
  relay.resumeProcesses();
  assert.equal(executions, 7); assert.equal(credentialRequests, 7); assert.equal(resolutions, 2);
  assert.ok((await start("write", "ssh fixture-host -- touch /tmp/owned")).error);
  assert.ok((await start("options", "ssh -i /tmp/key fixture-host -- uname")).error);
  assert.ok((await start("bad-curl", "ssh fixture-host -- curl -X POST https://example.test")).error);
  assert.ok((await start("bad-extra", "ssh fixture-host -- sichek daemon")).error);
  assert.ok((await start("untrusted-path", "ssh fixture-host -- /tmp/mmlscluster --ces")).error);
  assert.ok((await start("netns-write", "ssh fixture-host --pod rdma-a --namespace test -- touch /tmp/owned")).error);
  assert.ok((await start("netns-override", "ssh fixture-host --pod rdma-a --namespace test -- ip netns exec cni-other show_gids")).error);
  setExtraCommands({});
  assert.ok((await start("removed-extra", "ssh fixture-host -- sichek gpu")).error);
  assert.equal(executions, 7); assert.equal(resolutions, 2);
  bound = false;
  assert.ok((await start("revoked", "ssh fixture-host -- uname")).result);
  const revokedDeadline = Date.now() + 20000;
  while (!events.some(e => e.method === "process/exited" && e.params.processId === "revoked")) {
    assert.ok(Date.now() < revokedDeadline); await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(executions, 7); assert.equal(credentialRequests, 7);
  assert.notEqual(events.find(e => e.method === "process/exited" && e.params.processId === "revoked").params.exitCode, 0);
  console.log("Native infrastructure smoke passed: official exec-server, shared whitelist/extras, broker SSH, Pod netns protocol fixture, remote-session cancellation, write denial, sanitized IPC and revoked binding; real Linux netns execution remains separate");
} finally {
  setExtraCommands({});
  socket?.close(); await relay.close(); broker.dispose(); await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
