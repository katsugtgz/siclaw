import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexKnowledge, buildCodexKnowledgeReadInstructions } from "./codex-knowledge.js";
import { KNOWLEDGE_CITATION_MANIFEST } from "../knowledge-citation-service.js";
import { createModelOutputRedactor } from "../../shared/model-output-redactor.js";

const roots: string[] = [];

it("directs native knowledge reads to the selected local navigation, not MCP discovery", () => {
  const text = buildCodexKnowledgeReadInstructions("/selected knowledge/mount");
  expect(text).toContain(JSON.stringify("/selected knowledge/mount/index.md"));
  expect(text).toContain("native exec_command in the siclaw environment");
  expect(text).toContain("not MCP resources");
  expect(text).toContain("Do not use list_mcp_resources or list_mcp_resource_templates");
  expect(text).toContain("do not require the user to provide a filesystem path");
  expect(text).toContain("read is refused or missing");
  expect(text).toContain("not the page-reading tool");
});

it("quotes a selected directory without injecting raw newlines into instructions", () => {
  const text = buildCodexKnowledgeReadInstructions("/selected\nknowledge/mount");
  expect(text).toContain(JSON.stringify("/selected\nknowledge/mount/index.md"));
  expect(text).not.toContain("/selected\nknowledge");
});
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-cite-"))); roots.push(root);
  const page = path.join(root, "guide.md");
  const raw = "---\nsources:\n  - resource: raw/feishu/runbook.md\n---\n# Guide\nInspect the GPU first.\n";
  fs.writeFileSync(page, raw);
  const manifest = path.join(root, KNOWLEDGE_CITATION_MANIFEST);
  fs.writeFileSync(manifest, JSON.stringify({ version: 1, repos: [{ id: "repo", root: "", sources: [
    { resource: "feishu/runbook.md", title: "GPU Runbook", url: "https://docs.feishu.cn/wiki/abc" },
  ] }] }));
  const events: any[] = [];
  const owned = new Set(["root", "child"]);
  const secrets = ["private-citation-secret"];
  const knowledge = new CodexKnowledge({ knowledgeDir: root, owned: id => owned.has(id),
    emit: (id, sources) => events.push({ id, sources }), redact: createModelOutputRedactor(() => secrets), sensitiveValues: () => secrets });
  const event = (method: string, item?: any, id = "root", turn = "turn-1") => knowledge.observe({ method,
    params: { threadId: id, turnId: turn, turn: { id: turn }, ...(item ? { item } : {}) } });
  event("turn/started");
  const read = (id = "root", output = raw, command = `cat ${page}`) => {
    const item = { id: "read-" + id, type: "commandExecution", command: `/bin/bash -lc '${command}'`, cwd: root };
    event("item/started", item, id);
    event("item/completed", { ...item, status: "completed", exitCode: 0, aggregatedOutput: output }, id);
  };
  const cite = async (id = "root", callId = "cite-" + id) => {
    event("item/started", { id: callId, type: "mcpToolCall", server: "siclaw_knowledge", tool: "knowledge_cite" }, id);
    return knowledge.call({ pages: [{ path: page, claim: "Inspect the GPU before replacing it." }] }, callId, new AbortController().signal);
  };
  return { root, page, raw, manifest, knowledge, events, owned, event, read, cite };
}

describe("Codex native citation provenance", () => {
  it("uses successful native full-page reads and the existing citation contract", async () => {
    const f = fixture(); f.read(); const result = await f.cite();
    expect(result.isError).toBe(false); expect(result.structuredContent).toMatchObject({ cited: 1 });
    expect(f.events[0]).toMatchObject({ id: "root", sources: [{ url: "https://docs.feishu.cn/wiki/abc", repoId: "repo", page: "guide.md" }] });
  });
  it("refuses unread, partial, transformed or failed output", async () => {
    for (const output of ["", "Inspect the GPU first.", "forged-output"]) {
      const f = fixture(); f.read("root", output); expect((await f.cite()).isError).toBe(true); expect(f.events).toEqual([]);
    }
    const f = fixture(); expect((await f.cite()).isError).toBe(true);
  });
  it("does not treat approved scripts, searches or remote transport as local knowledge reads", async () => {
    for (const command of ["bash approved.sh", "ssh host -- cat guide.md", "rg GPU guide.md"]) {
      const f = fixture(); f.read("root", f.raw, command); expect((await f.cite()).isError).toBe(true);
    }
  });
  it("accepts native head/tail only when the observed output is the complete page", async () => {
    for (const binary of ["head", "tail"]) {
      const f = fixture(); f.read("root", f.raw, `${binary} -n 200 ${f.page}`); expect((await f.cite()).structuredContent?.cited).toBe(1);
      const partial = fixture(); partial.read("root", "# Guide\n", `${binary} -n 1 ${partial.page}`);
      expect((await partial.cite()).isError).toBe(true);
    }
  });
  it("refuses changed content and remount during a read", async () => {
    const f = fixture(); const item = { id: "read", type: "commandExecution", command: `cat ${f.page}`, cwd: f.root };
    f.event("item/started", item); fs.writeFileSync(f.page, f.raw + "changed\n");
    f.event("item/completed", { ...item, status: "completed", exitCode: 0, aggregatedOutput: f.raw });
    expect((await f.cite()).isError).toBe(true);
    const g = fixture(); g.event("item/started", { ...item, cwd: g.root, command: `cat ${g.page}` });
    fs.writeFileSync(g.manifest, JSON.stringify({ version: 1, repos: [] }));
    g.event("item/completed", { ...item, cwd: g.root, command: `cat ${g.page}`, status: "completed", exitCode: 0, aggregatedOutput: g.raw });
    expect((await g.cite()).isError).toBe(true); expect(g.events).toEqual([]);
  });
  it("keeps reads and citation events separate for root, child and future turns", async () => {
    const f = fixture(); f.event("turn/started", undefined, "child"); f.read("child");
    expect((await f.cite("root")).isError).toBe(true);
    expect((await f.cite("child")).isError).toBe(false); expect(f.events[0].id).toBe("child");
    f.event("turn/completed", undefined, "child"); f.event("turn/started", undefined, "child", "turn-2");
    f.owned.delete("child");
    const stop = AbortSignal.abort();
    expect((await f.knowledge.call({}, "cite-child", stop)).isError).toBe(true);
  });
  it("never accepts a model-chosen thread or read receipt in arguments", async () => {
    const f = fixture(); f.read();
    const result = await f.knowledge.call({ threadId: "root", turnId: "turn-1", read: true }, "unknown", AbortSignal.abort());
    expect(result.isError).toBe(true); expect(f.events).toEqual([]);
  });
  it("rejects symlinks and unsafe source URLs without leaking their credentials", async () => {
    const f = fixture(); const link = path.join(f.root, "link.md"); fs.symlinkSync(f.page, link);
    f.read("root", f.raw, `cat ${link}`); expect((await f.cite()).isError).toBe(true);
    const g = fixture(); const manifest = JSON.parse(fs.readFileSync(g.manifest, "utf8"));
    manifest.repos[0].sources[0].url += "?token=private-citation-secret"; fs.writeFileSync(g.manifest, JSON.stringify(manifest));
    g.read(); const result = await g.cite(); expect(result.isError).toBe(true);
    expect(JSON.stringify(g.events)).not.toContain("private-citation-secret");
  });
});
