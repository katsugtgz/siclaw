import { execFileSync } from "node:child_process";
import { resolveCapabilities } from "./tool-capabilities.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fixture.root,
    default: { ...actual.default, homedir: () => fixture.root } };
});
vi.mock("./config.js", async importOriginal => ({
  ...await importOriginal<typeof import("./config.js")>(),
  loadConfig: () => ({ providers: {}, allowedTools: null, paths: {
    skillsDir: ".siclaw/skills", userDataDir: ".siclaw/user-data",
    knowledgeDir: ".siclaw/knowledge", reposDir: "repos", docsDir: "docs", gitReposDir: "gitrepos",
    credentialsDir: ".siclaw/credentials",
  } }),
  getConfigPath: () => path.join(fixture.root, ".siclaw/config/settings.json"),
  getDefaultLlm: () => undefined,
  isMemoryEnabled: () => false,
}));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...await importOriginal<typeof import("@earendil-works/pi-coding-agent")>(),
  getAgentDir: () => path.join(fixture.root, "agent-config"),
}));
// Keep the real factory, resource loader and SDK file tools. No provider or
// model session is needed to exercise discovery and filesystem operations.
vi.mock("./pi-execution.js", () => ({
  createPiExecutionSession: async () => ({ session: { agent: {} }, extensionsResult: {},
    modelEnvelopeManifestRef: {}, modelEnvelopeInspectionRef: {},
  }),
}));
import { createSiclawSession } from "./agent-factory.js";
import type { McpClientManager } from "./mcp-client.js";
import { CodexAgentBrain } from "./brains/codex-agent-brain.js";

const sessions: Awaited<ReturnType<typeof createSiclawSession>>[] = [];
beforeEach(async () => {
  fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-boundary-"));
  vi.spyOn(process, "cwd").mockReturnValue(fixture.root);
});
afterEach(async () => {
  for (const session of sessions.splice(0)) session.knowledgeIndexer?.close();
  vi.restoreAllMocks();
  await fs.rm(fixture.root, { recursive: true, force: true });
});

it("projects frequent inventory capabilities without granting shell execution", async () => {
  const create = vi.spyOn(CodexAgentBrain, "create").mockResolvedValue({ brainType: "codex", getTools: () => [], close: async () => {} } as never);
  const broker = { getChannelPolicy:()=>undefined,validateChannelPolicy:async()=>{},getSensitiveValues: () => [], refreshClusters: vi.fn(), refreshHosts: vi.fn() };
  const result = await createSiclawSession({ agentEngine: "codex", agentType: "custom", mode: "web", userId: "owner",
    sessionManager: SessionManager.create(fixture.root, path.join(fixture.root, "inventory-transcripts")),
    allowedTools: ["cluster_list", "host_list"], kubeconfigRef: { credentialsDir: "/private/credentials", credentialBroker: broker as never } });
  sessions.push(result);
  expect(create).toHaveBeenCalledOnce();
  const options = create.mock.calls[0][0];
  expect(options.workflow).toMatchObject({ clusterList: true, hostList: true, allowClusterProbe: false });
  expect(options.grants.allowCommands).toBe(false); expect(options.environments).toEqual([]);
  expect(broker.refreshClusters).not.toHaveBeenCalled(); expect(broker.refreshHosts).not.toHaveBeenCalled();
});

it("advertises native Pod netns selectors without granting ordinary API or Pod exec", async () => {
  const create = vi.spyOn(CodexAgentBrain, "create").mockResolvedValue({ brainType: "codex", getTools: () => [], close: async () => {} } as never);
  const broker = { getChannelPolicy:()=>undefined,validateChannelPolicy:async()=>{},getSensitiveValues: () => [], refreshClusters: vi.fn().mockResolvedValue([{ name: "bound" }]),
    refreshHosts: vi.fn().mockResolvedValue([{ name: "bound-host" }]) };
  const result = await createSiclawSession({ agentEngine: "codex", agentType: "custom", mode: "web", userId: "owner",
    sessionManager: SessionManager.inMemory(fixture.root), allowedTools: ["node_exec", "host_exec"],
    kubeconfigRef: { credentialsDir: "/private/credentials", credentialBroker: broker as never } });
  sessions.push(result);
  const options = create.mock.calls[0][0];
  expect(options.systemPrompt).toContain("debug pod/<pod>");
  expect(options.systemPrompt).toContain("--pod <pod> --namespace <namespace>");
  expect(options.systemPrompt).toContain("does not create an ephemeral container");
  expect(options.environments?.[0].grants.infrastructure).toMatchObject({ allowNode: true, allowPod: false, allowApi: false });
});

it("projects native code capabilities without granting mirror file access", async () => {
  const create = vi.spyOn(CodexAgentBrain, "create").mockResolvedValue({ brainType: "codex", getTools: () => [], close: async () => {} } as never);
  const result = await createSiclawSession({ agentEngine: "codex", agentType: "custom", mode: "web", agentId: "agent-a",
    allowedTools: ["read", "ls"], sessionManager: SessionManager.inMemory(fixture.root) });
  sessions.push(result);
  const options = create.mock.calls[0][0];
  expect(options.code).toMatchObject({ recursiveList: false,
    allowed: { git_query: false, code_read: true, code_list: true, code_search: false } });
  expect(options.code!.artifacts).toBe(result.toolResultArtifactStore);
  expect(options.grants.deniedRoots).toContain(options.code!.view.gitReposDir);
  expect(options.grants.readRoots).not.toContain(options.code!.view.gitReposDir);
});

it("connects native preview, feedback receipt and channel delivery to the owned session", async () => {
  const create = vi.spyOn(CodexAgentBrain, "create").mockResolvedValue({ brainType: "codex", getTools: () => [], close: async () => {} } as never);
  const manager = SessionManager.inMemory(fixture.root), channel = vi.fn();
  const result = await createSiclawSession({ agentEngine: "codex", agentType: "custom", mode: "channel", userId: "owner",
    allowedTools: ["write", "edit", "skill_preview", "save_feedback", "channel_update"], sessionManager: manager, channelMessageExecutor: channel });
  sessions.push(result);
  const options = create.mock.calls[0][0];
  expect(options.workflow?.draftsRoot).toBe(path.join(fixture.root, ".siclaw/user-data/skill-drafts", manager.getSessionId()));
  expect(options.workflow?.channelUpdate).toBe(channel);
  const receipt = await options.workflow!.feedback!.persist({ summary: "feedback", sessionId: "owned", userId: "owner" });
  expect(receipt.id).toBeTruthy();
  expect(manager.getEntries().find(entry => entry.id === receipt.id)).toMatchObject({ type: "custom", customType: "product-feedback", data: { summary: "feedback", userId: "owner" } });
  expect(options.systemPrompt).toContain(options.workflow!.draftsRoot!);
});

it("does not acknowledge feedback buffered before a disk review conversation", async () => {
  const create = vi.spyOn(CodexAgentBrain, "create").mockResolvedValue({ brainType: "codex", getTools: () => [], close: async () => {} } as never);
  const manager = SessionManager.create(fixture.root, path.join(fixture.root, "sessions"));
  const result = await createSiclawSession({ agentEngine: "codex", agentType: "custom", mode: "web", userId: "owner",
    allowedTools: ["save_feedback"], sessionManager: manager });
  sessions.push(result);
  const persist = create.mock.calls[0][0].workflow!.feedback!.persist;
  await expect(persist({ summary: "not durable" })).rejects.toThrow(/persisted feedback review/);
  expect(manager.getEntries().filter(e => e.type === "custom" && e.customType === "product-feedback")).toHaveLength(0);
});
async function skill(relative: string, name: string) {
  const file = path.join(fixture.root, relative, name, "SKILL.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `---\nname: ${name}\ndescription: Synthetic boundary fixture\n---\nUse synthetic evidence.\n`);
}
async function create(agentType: "sre" | "custom" | "knowledge_qa", scoped = true, extra: Parameters<typeof createSiclawSession>[0] = {}) {
  const result = await createSiclawSession({ agentType, mode: scoped ? "web" : "cli", ...(scoped ? { agentId: "agent-a" } : {}),
    sessionManager: SessionManager.create(fixture.root, path.join(fixture.root, "sessions")), ...extra,
  });
  sessions.push(result);
  return result;
}
describe("factory resource boundaries", () => {
  it("blocks credential symlinks and another temp workspace, and sanitizes scoped file reads before model delivery", async () => {
    const result = await create("sre");
    const workspace = path.join(fixture.root, ".siclaw/user-data");
    const credentials = path.join(fixture.root, ".siclaw/credentials");
    await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(credentials, { recursive: true });
    await fs.writeFile(path.join(credentials, "cluster.key"), "private credential marker");
    await fs.symlink(credentials, path.join(workspace, "alias"));
    const read = result.customTools.find(tool => tool.name === "read")!;
    await expect(read.execute("link", { path: path.join(workspace, "alias/cluster.key") })).rejects.toThrow(/blocked|outside/);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "other-owner-"));
    try {
      await fs.writeFile(path.join(other, "data"), "private other owner");
      await expect(read.execute("other", { path: path.join(other, "data") })).rejects.toThrow(/outside/);
    } finally { await fs.rm(other, { recursive: true, force: true }); }
    await fs.writeFile(path.join(workspace, "evidence"), "healthy evidence\npassword: tiny\n");
    const safe = await read.execute("evidence", { path: path.join(workspace, "evidence") });
    expect(JSON.stringify(safe)).toContain("healthy evidence"); expect(JSON.stringify(safe)).not.toContain("tiny");
  });
  it.each(["sre", "custom", "knowledge_qa"] as const)("filters ambient Skills before the first %s sync", async type => {
    await skill("agent-config/skills", "ambient-helper");
    await skill("skills/core", "bundled-helper");
    const result = await create(type);
    expect(result.skillNames).toContain("bundled-helper");
    expect(result.skillNames).not.toContain("ambient-helper");
  });
  it("filters ambient Skills with an older Runtime's read-only QA whitelist", async () => {
    await skill("agent-config/skills", "ambient-helper");
    const result = await create("knowledge_qa", true, { allowedTools: ["read", "grep", "find", "ls"] });
    expect(result.skillNames).not.toContain("ambient-helper");
  });
  it("does not treat an unidentified web session as standalone CLI", async () => {
    await skill("agent-config/skills", "ambient-helper");
    expect((await create("sre", false, { mode: "web" })).skillNames).not.toContain("ambient-helper");
  });
  it("keeps an explicit missing Portal directory authoritative", async () => {
    await skill("agent-config/skills", "ambient-helper");
    const result = await create("custom", false, { portalSkillsDir: path.join(fixture.root, "portal/resolved") });
    expect(result.skillNames).not.toContain("ambient-helper");
  });
  it.each(["sre", "custom"] as const)("preserves unscoped %s CLI discovery", async type => {
    await skill("agent-config/skills", "ambient-helper");
    expect((await create(type, false)).skillNames).toContain("ambient-helper");
  });
  it("tells a refused grep the path is off-limits, not that it is absent", async () => {
    // grep is the only file tool that rewrites its operations' errors: a bare `catch {}` around
    // its isDirectory probe answers "Path not found" for every failure. So a path that EXISTS and
    // is merely outside the allow-list read as absent — and the two have opposite next steps.
    // `/app` is this image's WORKDIR and is not readable; three traces show an agent told the
    // source tree does not exist and going off to look for it elsewhere.
    const result = await create("sre");
    const grep = result.customTools.find(tool => tool.name === "grep")!;

    // Not under the fixture root: that lives in os.tmpdir(), which IS on the read allow-list,
    // so a directory beneath it would sail through the gate and prove nothing. /etc exists on
    // every platform this runs on and is on no allow-list — the same shape as /app in the image.
    await expect(grep.execute("off-limits", { pattern: "needle", path: "/etc" }))
      .rejects.toThrow(/outside allowed directories/);

    // A path inside the allow-list that genuinely does not exist keeps the original answer.
    await expect(grep.execute("absent", { pattern: "needle", path: path.join(fixture.root, ".siclaw/user-data/nope") }))
      .rejects.toThrow(/Path not found/);

    // Either way it REJECTS — that is what makes it an error rather than an empty search.
    // (pi maps a thrown tool onto isError:true, which is what the outcome column reads.)
  });

  it("serves a <repo>@<sha> path from the mounted mirror through all four file tools", async () => {
    // Wiring only — the semantics are pinned in src/tools/code-view/code-view.test.ts.
    // What this guards: every file tool the factory builds routes through the code
    // view, and a physical path next to it is untouched.
    const work = path.join(fixture.root, "work");
    await fs.mkdir(path.join(work, "src"), { recursive: true });
    await fs.writeFile(path.join(work, "src/app.ts"), "export const needle = 1;\n");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd }).toString().trim();
    git(fixture.root, "init", "-q", work);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "x");
    const sha = git(work, "rev-parse", "HEAD");
    git(fixture.root, "clone", "-q", "--bare", work, path.join(fixture.root, "gitrepos/app.git"));
    await fs.mkdir(path.join(fixture.root, "repos/app@latest"), { recursive: true });
    await fs.writeFile(path.join(fixture.root, "repos/app@latest/physical.txt"), "on disk\n");
    await fs.writeFile(path.join(fixture.root, "repos/.gitrepos.json"), JSON.stringify({
      version: 1, repos: [{ name: "app", host: "h", path: "g/app", bare: "mirrors/h/g/app.git" }],
      rules: { exclude_dirs: ["node_modules"], max_file_bytes: 1024 },
    }));

    const result = await create("custom", true, { allowedTools: resolveCapabilities(["read_files", "read_code"]) });
    const tool = (name: string) => result.customTools.find(t => t.name === name)!;
    const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map(c => c.text ?? "").join("");
    const virtualRoot = path.join(fixture.root, "repos", `app@${sha.slice(0, 8)}`);

    expect(text(await tool("read").execute("r", { path: path.join(virtualRoot, "src/app.ts") }))).toContain("export const needle = 1;");
    expect(text(await tool("ls").execute("l", { path: virtualRoot }))).toBe("src/");
    expect(text(await tool("find").execute("f", { pattern: "**/*.ts", path: virtualRoot }))).toBe("src/app.ts");
    expect(text(await tool("grep").execute("g", { pattern: "needle", path: virtualRoot }))).toBe("src/app.ts:1: export const needle = 1;");
    await expect(tool("read").execute("u", { path: path.join(fixture.root, "repos", `other@${sha}`, "x") }))
      .rejects.toThrow(/Unknown repository "other"/);
    expect(text(await tool("read").execute("p", { path: path.join(fixture.root, "repos/app@latest/physical.txt") }))).toBe("on disk\n");
    // git_query is a registry tool; it must answer from the SAME code view.
    const refsOut = await tool("git_query").execute("q", { op: "refs", repo: "app" }, undefined, undefined, undefined as never);
    expect(text(refsOut)).toMatch(new RegExp(`^${sha}\trefs/heads/`));
  });

  it("does not offer git_query when no mirror is mounted", async () => {
    const result = await create("custom", true, { allowedTools: resolveCapabilities(["read_files", "read_code"]) });
    expect(result.customTools.map(t => t.name)).not.toContain("git_query");
    expect(result.customTools.map(t => t.name)).toContain("read");
  });

  it("keeps QA working files inside user-data through the factory's real Write tool", async () => {
    const result = await create("knowledge_qa");
    const write = result.customTools.find(tool => tool.name === "write")!;
    const inside = path.join(fixture.root, ".siclaw/user-data/report.md");
    await write.execute("inside", { path: inside, content: "Research result" });
    expect(await fs.readFile(inside, "utf8")).toBe("Research result");
    const outsideDir = path.join(fixture.root, "outside");
    await fs.mkdir(outsideDir);
    await fs.symlink(outsideDir, path.join(fixture.root, ".siclaw/user-data/link"));
    await expect(write.execute("link", { path: path.join(fixture.root, ".siclaw/user-data/link/escaped.md"), content: "Denied" })).rejects.toThrow(/blocked/);
    await expect(fs.access(path.join(outsideDir, "escaped.md"))).rejects.toThrow();
    const edit = result.customTools.find(tool => tool.name === "edit")!;
    await edit.execute("edit-inside", { path: inside, edits: [{ oldText: "Research result", newText: "Updated result" }] });
    expect(await fs.readFile(inside, "utf8")).toBe("Updated result");
    const external = path.join(outsideDir, "existing.md");
    await fs.writeFile(external, "Original");
    const linked = path.join(fixture.root, ".siclaw/user-data/linked.md");
    await fs.symlink(external, linked);
    await expect(edit.execute("edit-link", { path: linked, edits: [{ oldText: "Original", newText: "Changed" }] })).rejects.toThrow(/blocked/);
    await expect(write.execute("write-link", { path: linked, content: "Changed" })).rejects.toThrow(/blocked/);
    expect(await fs.readFile(external, "utf8")).toBe("Original");
    const outside = path.join(fixture.root, "outside.md");
    await expect(write.execute("outside", { path: outside, content: "Denied" })).rejects.toThrow(/blocked/);
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it("appends each shared MCP server's instructions to the dynamic prompt layer", async () => {
    // A sub-agent is handed its parent's manager; the instructions come from
    // that manager, so parent and child read the same text.
    const shared = {
      getTools: () => [],
      getServerInstructions: () => [{ serverName: "devops", instructions: "Start here: inventory view=project." }],
    } as unknown as McpClientManager;
    const withMcp = await create("sre", true, { mcpManager: shared });
    const append = withMcp.services.resourceLoader.getAppendSystemPrompt();
    expect(append.filter((part) => part.includes("## MCP server"))).toEqual([
      "\n## MCP server \"devops\"\n\nInstructions this server sent for its tools (`mcp__devops__*`):\n\nStart here: inventory view=project.",
    ]);

    const without = await create("sre");
    expect(without.services.resourceLoader.getAppendSystemPrompt().some((part) => part.includes("## MCP server"))).toBe(false);
  });
});
