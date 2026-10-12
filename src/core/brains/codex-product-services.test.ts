import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexWorkflow } from "./codex-workflow.js";
import type { KubeconfigRef } from "../types.js";
import type { CredentialBroker } from "../../agentbox/credential-broker.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const broker = { refreshClusters: vi.fn().mockResolvedValue([]), isClustersReady: () => true,
    getClustersLocal: vi.fn().mockReturnValue([{ name: "prod-a", is_production: true,
      meta: [{ key: "rdma", value: "roce", display_name: "RDMA" }, { key: "registry", value: "private-plumbing" }] }]),
    queryHosts: vi.fn().mockResolvedValue({ hosts: [{ id: "h-1", name: "gpu-1", ip: "10.0.0.1", port: 22, username: "reader",
      auth_type: "key", is_production: true, jump_host: "bastion", password: "MUST_NOT_RETURN", private_key: "MUST_NOT_RETURN" }], total: 101, next_cursor: "next-page" }),
    probeClusters: vi.fn().mockResolvedValue([{ name: "prod-a", probe_status: "probe_failed", reason: "authz", reachable: true, probe_error: "Forbidden" }]),
    acquireCluster: vi.fn(), acquireHost: vi.fn(), ensureCluster: vi.fn(), ensureHost: vi.fn() };
  const ref = { credentialsDir: "/private/credentials", credentialBroker: broker as unknown as CredentialBroker } satisfies KubeconfigRef;
  const service = new CodexWorkflow({ schedule: false, report: false, sessionId: () => "owned-session", kubeconfigRef: ref,
    clusterList: true, hostList: true, active: () => ({ threadId: "root", turnId: "turn" }) });
  return { broker, ref, service };
}
function start(service: CodexWorkflow, name: string, args: Record<string, unknown>, id = "call", threadId = "root") {
  service.observe({ method: "item/started", params: { threadId, turnId: "turn",
    item: { id, type: "mcpToolCall", server: "siclaw_workflow", tool: name, arguments: args } } });
}
const call = (service: CodexWorkflow, name: string, args: Record<string, unknown>, id = "call") => service.call(args, id, new AbortController().signal, name);

describe("native fleet metadata and owned product services", () => {
  it("exposes both frequent metadata tools with no shell, file or credential capability", async () => {
    const f = fixture(); expect(f.service.tools.map(t => t.name)).toEqual(["cluster_list", "host_list"]);
    start(f.service, "cluster_list", { name: "PROD", probe: false });
    const result = await call(f.service, "cluster_list", { name: "PROD", probe: false });
    expect(result.structuredContent).toMatchObject({ clusters: [{ name: "prod-a", meta: { rdma: "roce" } }] });
    expect(JSON.stringify(result)).not.toContain("private-plumbing");
    expect(f.broker.refreshClusters).toHaveBeenCalledTimes(1);
    expect(f.broker.probeClusters).not.toHaveBeenCalled(); expect(f.broker.acquireCluster).not.toHaveBeenCalled();
  });
  it("keeps server-side search, cap and cursor without loading or acquiring all hosts", async () => {
    const f = fixture(), args = { query: " 10.0.0.1 ", limit: 100, cursor: "page-1" };
    start(f.service, "host_list", args); const result = await call(f.service, "host_list", args);
    expect(f.broker.queryHosts).toHaveBeenCalledWith("10.0.0.1", { limit: 100, cursor: "page-1" });
    expect(result.structuredContent).toMatchObject({ total: 101, next_cursor: "next-page", hosts: [{ jump_host: "bastion" }] });
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_RETURN"); expect(f.broker.acquireHost).not.toHaveBeenCalled();
  });
  it.each([{ probe: true }, { agent_id: "other" }, { name: 1 }])("rejects inventory escalation before broker access: %j", async args => {
    const f = fixture(); start(f.service, "cluster_list", args);
    await expect(call(f.service, "cluster_list", args)).rejects.toThrow(); expect(f.broker.refreshClusters).not.toHaveBeenCalled();
  });
  it.each([{ limit: 101 }, { limit: 1.5 }, { cursor: "x".repeat(4097) }, { userId: "other" }])("rejects invalid pagination/identity: %j", async args => {
    const f = fixture(); start(f.service, "host_list", args);
    await expect(call(f.service, "host_list", args)).rejects.toThrow(); expect(f.broker.queryHosts).not.toHaveBeenCalled();
  });
  it("only permits explicit API probing under the corresponding capability", async () => {
    const f = fixture(); const service = new CodexWorkflow({ schedule: false, report: false, sessionId: () => "s", kubeconfigRef: f.ref,
      clusterList: true, allowClusterProbe: true, active: () => ({ threadId: "root", turnId: "turn" }) });
    start(service, "cluster_list", { probe: true }); const result = await call(service, "cluster_list", { probe: true });
    expect(f.broker.probeClusters).toHaveBeenCalledWith(["prod-a"]);
    expect(result.structuredContent).toMatchObject({ clusters: [{ probe_status: "probe_failed", probe_reason: "authz", reachable: true }] });
  });
  it("denies substituted arguments and replay of the same native call", async () => {
    const f = fixture(); start(f.service, "host_list", { query: "gpu" });
    await expect(call(f.service, "host_list", { query: "other" })).rejects.toThrow(/matching arguments/);
    expect(f.broker.queryHosts).not.toHaveBeenCalled(); await call(f.service, "host_list", { query: "gpu" });
    await expect(call(f.service, "host_list", { query: "gpu" })).rejects.toThrow(/already dispatched/);
  });
  it("suppresses stale results after Stop even if metadata transport completes", async () => {
    const f = fixture(); let finish!: (v: unknown) => void;
    f.broker.queryHosts.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    start(f.service, "host_list", {}); const result = call(f.service, "host_list", {}); f.service.cancel();
    finish({ hosts: [], total: 0, next_cursor: null }); await expect(result).rejects.toThrow(/owned turn|aborted/);
  });
  it("allows attributed child metadata, but never child feedback writes", async () => {
    const f = fixture(), persist = vi.fn();
    const service = new CodexWorkflow({ schedule: false, report: false, sessionId: () => "parent", kubeconfigRef: f.ref,
      hostList: true, feedback: { userId: "owner", persist }, active: () => undefined,
      ownsRead: (id, turn) => id === "child" && turn === "turn" });
    start(service, "host_list", {}, "read", "child"); expect((await call(service, "host_list", {}, "read")).isError).toBe(false);
    start(service, "save_feedback", { overallRating: 5, summary: "bad child write" }, "write", "child");
    await expect(service.call({ overallRating: 5, summary: "bad child write" }, "write", AbortSignal.timeout(5), "save_feedback")).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
  });
  it("previews only the owned draft, keeps UI details, cleans only that draft and never executes scripts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-preview-")); roots.push(root);
    const draftsRoot = path.join(root, "skill-drafts", "owner"), dir = path.join(draftsRoot, "demo"), other = path.join(root, "skill-drafts", "other", "demo");
    for (const value of [dir, other]) { fs.mkdirSync(value, { recursive: true }); fs.writeFileSync(path.join(value, "SKILL.md"), "---\nname: demo\ndescription: Safe test\n---\n# Test\n"); }
    fs.mkdirSync(path.join(dir, "scripts")); fs.writeFileSync(path.join(dir, "scripts", "check.sh"), "#!/bin/sh\nprintf 'not executed'\n");
    const service = new CodexWorkflow({ schedule: false, report: false, sessionId: () => "s", draftsRoot, cwd: root,
      active: () => ({ threadId: "root", turnId: "turn" }) });
    start(service, "skill_preview", { dir: other }, "other"); expect((await call(service, "skill_preview", { dir: other }, "other")).isError).toBe(true);
    expect(fs.existsSync(other)).toBe(true); start(service, "skill_preview", { dir });
    const result = await call(service, "skill_preview", { dir }); expect(result.structuredContent).toHaveProperty("skillPreview.skill.files");
    expect(fs.existsSync(dir)).toBe(false); expect(fs.existsSync(other)).toBe(true);
  });
  it("binds feedback attribution and channel recipients to trusted context", async () => {
    const persist = vi.fn().mockResolvedValue({ id: "stored-report" }), channelUpdate = vi.fn().mockResolvedValue({ delivered: true, message: "sent" });
    const service = new CodexWorkflow({ schedule: false, report: false, sessionId: () => "owner-session",
      feedback: { userId: "owner-user", agentId: "owner-agent", persist }, channelUpdate,
      active: () => ({ threadId: "root", turnId: "turn" }) });
    const feedback = { overallRating: 5, summary: "Good", tags: '["safe"]' };
    start(service, "save_feedback", feedback, "feedback"); expect((await call(service, "save_feedback", feedback, "feedback")).isError).toBe(false);
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "owner-session", userId: "owner-user", agentId: "owner-agent", tags: ["safe"] }));
    start(service, "channel_update", { text: "A milestone" }, "channel"); await call(service, "channel_update", { text: "A milestone" }, "channel");
    expect(channelUpdate).toHaveBeenCalledWith({ sessionId: "owner-session", kind: "milestone", text: "A milestone" });
    start(service, "channel_update", { text: "bad", sessionId: "other" }, "spoof");
    await expect(call(service, "channel_update", { text: "bad", sessionId: "other" }, "spoof")).rejects.toThrow(/unsupported field/);
  });
});
