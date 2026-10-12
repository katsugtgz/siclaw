import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CodexCode, CODEX_CODE_SERVER } from "./codex-code.js";
import { CodexMcpGateway } from "./codex-mcp-gateway.js";
import { CodexAgentBrain } from "./codex-agent-brain.js";
import { CodeView } from "../../tools/code-view/view.js";
import { createGitQueryTool } from "../../tools/code-view/git-query.js";
import { ToolResultArtifactStore } from "../tool-result-artifact.js";

let root: string, reposDir: string, gitReposDir: string, sha: string, parent: string;
let view: CodeView, store: ToolResultArtifactStore, service: CodexCode;
let scope = { agentId: "agent", sessionId: "session" };
let owned: boolean, ticket: boolean;
const ownedThreads = new Set(["root", "child"]);
const allowed = { git_query: true, code_read: true, code_list: true, code_search: true };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=test@example.test", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd }).toString().trim();
function manifest(names = ["app"], excludes = ["node_modules"]) {
  fs.writeFileSync(path.join(reposDir, ".gitrepos.json"), JSON.stringify({ version: 1, updated_at: "t",
    repos: names.map(name => ({ name, host: "gitlab.test", path: `group/${name}`, bare: `mirrors/gitlab.test/group/${name}.git` })),
    rules: { exclude_dirs: excludes, max_file_bytes: 1024 * 1024 } }));
}
function start(tool: string, args: Record<string, unknown>, id = "call", threadId = "root", turnId = "turn") {
  service.observe({ method: "item/started", params: { threadId, turnId,
    item: { type: "mcpToolCall", server: CODEX_CODE_SERVER, tool, id, arguments: args } } });
}
function call(tool: string, args: Record<string, unknown>, id = "call", threadId = "root") {
  start(tool, args, id, threadId);
  return service.call(args, id, new AbortController().signal, tool);
}
const virtual = (file = "", commit = sha) => path.join(reposDir, `app@${commit}`, file);
const finish = (id: string) => service.observe({ method: "item/completed", params: { threadId: "root", turnId: "turn", item: { id } } });

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "native-code-"));
  reposDir = path.join(root, ".siclaw/repos"); gitReposDir = path.join(root, ".siclaw/gitrepos");
  fs.mkdirSync(reposDir, { recursive: true }); fs.mkdirSync(gitReposDir, { recursive: true });
  const work = path.join(root, "work"); git(root, "init", "-q", "-b", "main", work);
  fs.mkdirSync(path.join(work, "src")); fs.mkdirSync(path.join(work, "node_modules"));
  fs.writeFileSync(path.join(work, "src/a.ts"), "alpha\nneedle\nomega\n");
  fs.writeFileSync(path.join(work, "node_modules/private.txt"), "hidden needle");
  git(work, "add", "."); git(work, "commit", "-qm", "initial"); parent = git(work, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(work, "src/b.ts"), "canary-secret\nsecond needle\n");
  fs.writeFileSync(path.join(work, "big.txt"), Array.from({ length: 1500 }, (_, i) => `row ${i} ${"x".repeat(100)}`).join("\n") + "\n");
  fs.writeFileSync(path.join(work, "huge.txt"), Array.from({ length: 6000 }, (_, i) => `huge ${i} ${"x".repeat(100)}`).join("\n") + "\n");
  git(work, "add", "."); git(work, "commit", "-qm", "large update"); sha = git(work, "rev-parse", "HEAD");
  git(root, "clone", "-q", "--bare", work, path.join(gitReposDir, "app.git"));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(async () => {
  vi.restoreAllMocks(); Object.assign(allowed, { git_query: true, code_read: true, code_list: true, code_search: true });
  owned = true; ticket = false; scope = { agentId: "agent", sessionId: "session" }; manifest();
  view = new CodeView({ reposDir, gitReposDir });
  store = new ToolResultArtifactStore({ rootDir: path.join(root, "artifacts"), getScope: () => scope });
  await store.initialize();
  service = new CodexCode({ view, cwd: root, artifacts: store, recursiveList: true, allowed,
    owns: (threadId, turnId) => owned && ownedThreads.has(threadId) && turnId === "turn",
    redact: text => text.replaceAll("canary-secret", "[REDACTED]"),
    authorizeTool: name => { if (ticket && name === "git_query") throw new Error("ticket result-only"); } });
});

describe("native commit code product service", () => {
  it("reuses Pi Git results and resolves immutable full SHAs", async () => {
    const args = { op: "log", repo: "app", ref: "main" };
    const pi = await createGitQueryTool(view).execute("pi", args);
    const native = await call("git_query", args);
    expect(native.structuredContent.content).toBe(pi.content[0].text);
    expect(native.structuredContent.content).toContain(sha);
  });
  it("reads any commit with line paging and names the exact full SHA", async () => {
    const first = await call("code_read", { path: virtual("src/a.ts", sha.slice(0, 9)), limit: 2 });
    expect(first.structuredContent).toMatchObject({ sha, content: "alpha\nneedle", next_offset: 3, complete: false });
    const rest = await call("code_read", { path: virtual("src/a.ts"), offset: 3 }, "rest");
    expect(rest.structuredContent).toMatchObject({ content: "omega", next_offset: null, complete: true });
    await expect(call("code_read", { path: virtual("src/b.ts", parent) }, "old")).resolves.toMatchObject({ isError: true, structuredContent: { reason: "path_not_found" } });
  });
  it("lists stable pages, respects globs and applies updated exclusions to cached trees", async () => {
    const first = await call("code_list", { path: virtual(), recursive: true, limit: 2 });
    expect(first.structuredContent).toMatchObject({ entries: [{ path: "big.txt" }, { path: "huge.txt" }], next_offset: 2, complete: false });
    const filtered = await call("code_list", { path: virtual(), recursive: true, glob: "**/*.ts" }, "glob");
    expect(filtered.structuredContent.entries).toEqual([{ path: "src/a.ts", type: "blob" }, { path: "src/b.ts", type: "blob" }]);
    manifest(["app"], ["node_modules", "src"]);
    const changed = await call("code_list", { path: virtual(), recursive: true }, "changed");
    expect(JSON.stringify(changed)).not.toContain("src/a.ts"); expect(JSON.stringify(changed)).not.toContain("node_modules");
  });
  it("shares virtual grep behavior, reports search limits and sanitizes output", async () => {
    const found = await call("code_search", { path: virtual("src"), pattern: "needle", literal: true });
    expect(found.structuredContent.content).toContain("a.ts:2: needle");
    expect(found.structuredContent.content).toContain("b.ts:2: second needle");
    const limited = await call("code_search", { path: virtual(), pattern: "needle", limit: 1 }, "limited");
    expect(limited.structuredContent).toMatchObject({ matchLimitReached: 1, complete: false });
    const safe = await call("code_read", { path: virtual("src/b.ts") }, "safe");
    expect(JSON.stringify(safe)).not.toContain("canary-secret"); expect(JSON.stringify(safe)).toContain("[REDACTED]");
  });
  it.each([() => path.join(gitReposDir, "app.git/HEAD"), () => path.join(root, "work/src/a.ts"),
    () => virtual("../src/a.ts")])("refuses excluded, physical, traversing and unauthorized paths", async filename => {
    await expect(call("code_read", { path: filename() })).rejects.toThrow();
  });
  it("returns actionable known code refusals without exposing withheld content", async () => {
    await expect(call("code_read", { path: virtual("node_modules/private.txt") }, "excluded")).resolves.toMatchObject({ isError: true, structuredContent: { reason: "excluded" } });
    await expect(call("code_read", { path: path.join(reposDir, `foreign@${sha}/src/a.ts`) }, "foreign")).resolves.toMatchObject({ isError: true, structuredContent: { reason: "unknown_repository" } });
  });
  it("does not advertise absent capabilities and refuses arguments outside the schema", async () => {
    const none = new CodexCode({ view, cwd: root, artifacts: store, recursiveList: false, allowed: { git_query: false, code_read: false, code_list: false, code_search: false },
      owns: () => true, redact: text => text });
    expect(none.tools).toEqual([]);
    const reads = new CodexCode({ view, cwd: root, artifacts: store, recursiveList: false, allowed: { git_query: false, code_read: true, code_list: false, code_search: false },
      owns: () => true, redact: text => text });
    expect(reads.tools.map(tool => tool.name)).toEqual(["code_read", "code_result_read"]);
    await expect(call("code_read", { path: virtual("src/a.ts"), limit: 2001 })).rejects.toThrow(/Invalid/);
  });
  it("binds server/tool/arguments/call ID/thread/turn, allows only owned children and rejects replay", async () => {
    const args = { path: virtual("src/a.ts") };
    start("code_read", args);
    await expect(service.call({ ...args, offset: 2 }, "call", new AbortController().signal, "code_read")).rejects.toThrow(/matching/);
    await expect(service.call(args, "call", new AbortController().signal, "code_list")).rejects.toThrow(/matching/);
    await expect(service.call(args, "call", new AbortController().signal, "code_read")).resolves.toMatchObject({ isError: false });
    await expect(service.call(args, "call", new AbortController().signal, "code_read")).rejects.toThrow(/already dispatched/);
    await expect(call("code_read", args, "child", "child")).resolves.toMatchObject({ isError: false });
    start("code_read", args, "foreign", "foreign");
    await expect(service.call(args, "foreign", AbortSignal.timeout(1), "code_read")).rejects.toThrow();
    service.observe({ method: "item/started", params: { threadId: "root", turnId: "old", item: { id: "stale", type: "mcpToolCall", server: CODEX_CODE_SERVER, tool: "code_read", arguments: args } } });
    await expect(service.call(args, "stale", AbortSignal.timeout(1), "code_read")).rejects.toThrow();
  });
  it.each(["stop", "turn", "item", "close", "ownership", "repository"])("rejects delivery after %s changes while the shared read runs", async reason => {
    const original = view.readFile.bind(view);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(view, "readFile").mockImplementation(async (loc, signal) => { const bytes = await original(loc, signal); entered(); await hold; return bytes; });
    const pending = call("code_read", { path: virtual("src/a.ts") });
    await ready;
    if (reason === "stop") service.cancel();
    else if (reason === "close") service.close();
    else if (reason === "item") finish("call");
    else if (reason === "turn") service.observe({ method: "turn/completed", params: { threadId: "root", turn: { id: "turn" } } });
    else if (reason === "ownership") owned = false;
    else manifest([]);
    release();
    if (reason === "repository") await expect(pending).resolves.toMatchObject({ isError: true, structuredContent: { reason: "revoked" } });
    else await expect(pending).rejects.toThrow();
  });
  it("pages complete available output without hiding Git business truncation", async () => {
    const large = await call("code_read", { path: virtual("big.txt"), limit: 2000 });
    expect(large.structuredContent).toMatchObject({ complete: false, query_complete: true, artifact_id: expect.any(String) });
    const id = large.structuredContent.artifact_id as string;
    let combined = "", offset = 0;
    for (let page = 0; page < 20; page++) {
      const result = await call("code_result_read", { artifact_id: id, offset, limit: 32000 }, `page-${page}`);
      combined += result.structuredContent.content;
      if (result.structuredContent.complete) break;
      offset = result.structuredContent.next_offset as number;
    }
    expect(JSON.parse(combined)).toMatchObject({ sha, content: expect.stringContaining("row 1499"), complete: true });
    const diff = await call("git_query", { op: "diff", repo: "app", from: parent, to: sha }, "diff");
    expect(diff.structuredContent).toMatchObject({ truncated: true, query_complete: false });
  });
  it("keeps artifacts scoped, capability-bound and unusable after exclusion or repository revocation", async () => {
    const large = await call("code_read", { path: virtual("big.txt"), limit: 2000 });
    const args = { artifact_id: large.structuredContent.artifact_id };
    scope = { agentId: "other", sessionId: "session" };
    await expect(call("code_result_read", args, "foreign")).rejects.toThrow();
    scope = { agentId: "agent", sessionId: "other" };
    await expect(call("code_result_read", args, "other-session")).rejects.toThrow();
    scope = { agentId: "agent", sessionId: "session" }; allowed.code_read = false;
    await expect(call("code_result_read", args, "capability")).rejects.toThrow(/capability/);
    allowed.code_read = true; manifest(["app"], ["node_modules", "src"]);
    await expect(call("code_result_read", args, "rules")).rejects.toThrow(/rules changed/);
    manifest([]); await expect(call("code_result_read", args, "revoked")).resolves.toMatchObject({ isError: true, structuredContent: { reason: "revoked" } });
    const unrelated = await store.capture({ text: "private", toolCallId: "x", toolName: "unrelated" });
    if (!("reference" in unrelated)) throw new Error("Fixture artifact failed");
    await expect(call("code_result_read", { artifact_id: unrelated.reference.id }, "unrelated")).rejects.toThrow(/not an authorized code/);
  });
  it("does not widen shallow listing into recursive find permission", async () => {
    service = new CodexCode({ view, cwd: root, artifacts: store, recursiveList: false,
      allowed: { git_query: false, code_read: false, code_list: true, code_search: false }, owns: () => true, redact: text => text });
    expect(service.tools.find(tool => tool.name === "code_list")!.inputSchema.properties!.recursive).toEqual({ type: "boolean", enum: [false] });
    await expect(call("code_list", { path: virtual(), recursive: true })).rejects.toThrow(/Recursive/);
    await expect(call("code_list", { path: virtual("src") }, "shallow")).resolves.toMatchObject({ structuredContent: { entries: [{ path: "a.ts" }, { path: "b.ts" }] } });
  });
  it("keeps artifact expiration and integrity checks at the existing store boundary", async () => {
    let now = Date.now();
    store = new ToolResultArtifactStore({ rootDir: path.join(root, "expiring-artifacts"), getScope: () => scope, ttlMs: 1000, now: () => now });
    service = new CodexCode({ view, cwd: root, artifacts: store, recursiveList: true, allowed, owns: () => true, redact: text => text });
    const large = await call("code_read", { path: virtual("big.txt"), limit: 2000 });
    const args = { artifact_id: large.structuredContent.artifact_id };
    now += 1001;
    await expect(call("code_result_read", args, "expired")).rejects.toThrow(/expired|not found/i);
    const current = await call("code_read", { path: virtual("big.txt"), limit: 2000 }, "new");
    const id = current.structuredContent.artifact_id as string;
    fs.writeFileSync(path.join(await store.scopedDirectory(), id + ".txt"), "tampered");
    await expect(call("code_result_read", { artifact_id: id }, "tampered")).rejects.toThrow(/integrity|size/i);
  });
  it("ticket scope allows code reads but blocks Git queries and their cached artifacts", async () => {
    const diff = await call("git_query", { op: "diff", repo: "app", from: parent, to: sha });
    ticket = true;
    await expect(call("git_query", { op: "refs", repo: "app" }, "blocked")).rejects.toThrow(/ticket/);
    await expect(call("code_result_read", { artifact_id: diff.structuredContent.artifact_id }, "cached")).rejects.toThrow(/ticket/);
    await expect(call("code_read", { path: virtual("src/a.ts") }, "read")).resolves.toMatchObject({ isError: false });
    const brain = Object.create(CodexAgentBrain.prototype) as any;
    brain.native = { grants: { writeRoots: [] } }; brain.ticketResultTool = "result";
    brain.nativeMcpServers = { siclaw_code: {} }; brain.code = service; brain.mcpGateway = { getTools: () => [] };
    brain.currentProviderConfig = () => ({ baseUrl: "https://example.test/v1" });
    expect(brain.codexConfig().mcp_servers.siclaw_code.enabled_tools).toEqual(["code_read", "code_list", "code_search", "code_result_read"]);
  });
  it("registers a distinct native route and requires owned attribution through actual MCP HTTP", async () => {
    const gateway = new CodexMcpGateway({});
    gateway.registerService(CODEX_CODE_SERVER, service.tools, (args, id, signal, name) => service.call(args, id, signal, name));
    const client = new Client({ name: "code-test", version: "1" });
    try {
      const config = (await gateway.start()).siclaw_code as { url: string; http_headers: Record<string, string>; tools: Record<string, { output_token_limit: number }> };
      expect(new URL(config.url).pathname).toBe("/code");
      expect(Object.keys(config.tools).sort()).toEqual(service.tools.map(tool => tool.name).sort());
      expect(config.tools.code_result_read.output_token_limit).toBe(64000);
      await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.http_headers } }));
      const args = { path: virtual("src/a.ts") }; start("code_read", args);
      const result = await client.callTool({ name: "code_read", arguments: args, _meta: { callId: "call" } });
      expect(result.isError).toBe(false); expect(JSON.stringify(result)).toContain("alpha");
      finish("call");
    } finally { await client.close(); await gateway.close(); }
  });
});
