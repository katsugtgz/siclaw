import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ToolResultArtifactStore,
  createToolResultArtifactTools,
  formatToolResultArtifactReference,
  formatUnrecoverableToolResult,
  getToolResultArtifactReference,
  isToolResultArtifactPath,
  withToolResultArtifactCapture,
  diagnoseNoMatch,
} from "./tool-result-artifact.js";

describe("ToolResultArtifactStore", () => {
  let rootDir: string;
  let now: number;
  let scope = { agentId: "agent-a", sessionId: "session-a" };

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-artifact-"));
    now = Date.parse("2026-09-03T00:00:00.000Z");
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  function store(options: { ttlMs?: number; maxArtifactBytes?: number; maxScopeBytes?: number; maxScopeArtifacts?: number } = {}) {
    return new ToolResultArtifactStore({
      rootDir,
      getScope: () => scope,
      now: () => now,
      ...options,
    });
  }

  it("persists complete text with digest and supports bounded continuation reads", async () => {
    const artifacts = store();
    const text = `prefix-${"x".repeat(40_000)}-ROOT_CAUSE-middle-${"y".repeat(40_000)}-tail`;
    const captured = await artifacts.capture({ text, toolCallId: "call-1", toolName: "mcp__logs__query" });
    expect(captured).toHaveProperty("reference");
    if (!("reference" in captured)) throw new Error("capture failed");

    expect(captured.reference.sizeChars).toBe(text.length);
    expect(captured.reference.sizeBytes).toBe(Buffer.byteLength(text));
    expect(captured.reference.sha256).toMatch(/^[0-9a-f]{64}$/);

    const first = await artifacts.read(captured.reference.id, 0, 32_000);
    expect(first.text).toBe(text.slice(0, 32_000));
    expect(first.nextOffset).toBe(32_000);
    expect(first.complete).toBe(false);

    let assembled = first.text;
    let cursor = first.nextOffset;
    while (cursor !== null) {
      const page = await artifacts.read(captured.reference.id, cursor, 32_000);
      assembled += page.text;
      cursor = page.nextOffset;
    }
    expect(assembled).toBe(text);
    expect((await fs.stat(rootDir)).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink as the private artifact root", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-symlink-"));
    try {
      const target = path.join(parent, "target");
      const symlink = path.join(parent, "artifact-root");
      await fs.mkdir(target);
      await fs.symlink(target, symlink, "dir");
      const artifacts = new ToolResultArtifactStore({
        rootDir: symlink,
        getScope: () => scope,
      });
      await expect(artifacts.initialize()).rejects.toThrow("real directory");
      await expect(artifacts.capture({ text: "evidence", toolCallId: "call", toolName: "mcp__x__y" }))
        .resolves.toEqual({
          failure: { version: 1, reason: "write_failed", sizeChars: 8, sizeBytes: 8 },
        });
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it("finds decisive evidence from the omitted middle", async () => {
    const artifacts = store();
    const text = `${"x".repeat(300_000)}ROOT_CAUSE: exhausted connection pool${"y".repeat(300_000)}`;
    const captured = await artifacts.capture({ text, toolCallId: "call-2", toolName: "mcp__logs__query" });
    if (!("reference" in captured)) throw new Error("capture failed");

    const result = await artifacts.search(captured.reference.id, "root_cause", 80, 5);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].offset).toBe(300_000);
    expect(result.matches[0].snippet).toContain("exhausted connection pool");
  });

  it("denies an artifact after the session scope changes", async () => {
    const artifacts = store();
    const captured = await artifacts.capture({ text: "private evidence", toolCallId: "call-3", toolName: "mcp__x__y" });
    if (!("reference" in captured)) throw new Error("capture failed");

    scope = { agentId: "agent-a", sessionId: "session-b" };
    await expect(artifacts.read(captured.reference.id)).rejects.toThrow("not found in this session");
  });

  it("expires artifacts and removes their files", async () => {
    const artifacts = store({ ttlMs: 1_000 });
    const captured = await artifacts.capture({ text: "temporary", toolCallId: "call-4", toolName: "mcp__x__y" });
    if (!("reference" in captured)) throw new Error("capture failed");

    now += 1_001;
    await expect(artifacts.read(captured.reference.id)).rejects.toThrow("expired");
    await expect(artifacts.read(captured.reference.id)).rejects.toThrow("not found");
  });

  it("fails closed for a single artifact beyond the configured limit", async () => {
    const artifacts = store({ maxArtifactBytes: 8 });
    const captured = await artifacts.capture({ text: "123456789", toolCallId: "call-5", toolName: "mcp__x__y" });
    expect(captured).toEqual({
      failure: { version: 1, reason: "too_large", sizeChars: 9, sizeBytes: 9 },
    });
  });

  it("refuses new artifacts at capacity without evicting valid evidence", async () => {
    const artifacts = store({ maxScopeBytes: 10 });
    const first = await artifacts.capture({ text: "123456", toolCallId: "call-6", toolName: "mcp__x__y" });
    if (!("reference" in first)) throw new Error("capture failed");
    now += 1;
    const second = await artifacts.capture({ text: "abcdef", toolCallId: "call-7", toolName: "mcp__x__y" });
    expect(second).toHaveProperty("failure");
    await expect(artifacts.read(first.reference.id)).resolves.toMatchObject({ text: "123456" });
  });

  it("caps the number of artifacts retained in one session scope", async () => {
    const artifacts = store({ maxScopeBytes: 1_000, maxScopeArtifacts: 1 });
    const first = await artifacts.capture({ text: "first", toolCallId: "call-8", toolName: "mcp__x__y" });
    if (!("reference" in first)) throw new Error("capture failed");
    now += 1;
    const second = await artifacts.capture({ text: "second", toolCallId: "call-9", toolName: "mcp__x__y" });
    expect(second).toHaveProperty("failure");
    await expect(artifacts.read(first.reference.id)).resolves.toMatchObject({ text: "first" });
  });
});

describe("tool-result artifact tools", () => {
  it("capture wrapper bounds live content and preserves the complete recoverable result", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-wrapper-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir,
        getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const wrapped = withToolResultArtifactCapture({
        name: "mcp__logs__query",
        label: "query",
        description: "query logs",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text" as const, text: `complete live result ${"x".repeat(40_000)}` }],
          details: { upstream: true },
        }),
      }, store);

      const result = await wrapped.execute("call-1", {}, undefined, undefined, undefined);
      expect((result.content[0] as any).text.length).toBeLessThanOrEqual(8000);
      expect((result.content[0] as any).text).toContain("artifact_id:");
      expect((result.details as any).upstream).toBe(true);
      const reference = getToolResultArtifactReference(result.details);
      expect(reference).not.toBeNull();
      const stored = await store.read(reference!.id);
      expect(stored.text).toBe(`complete live result ${"x".repeat(40_000)}`.slice(0, 16_000));
      expect(stored.complete).toBe(false);
      expect(reference!.sizeChars).toBe(`complete live result ${"x".repeat(40_000)}`.length);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("does not spill small MCP results", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-small-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir,
        getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const wrapped = withToolResultArtifactCapture({
        name: "mcp__status__get",
        label: "status",
        description: "get status",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: "healthy" }] }),
      }, store);

      const result = await wrapped.execute("call-small", {}, undefined, undefined, undefined);
      expect(result).toEqual({ content: [{ type: "text", text: "healthy" }] });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("read and search tools expose bounded data without accepting paths", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-tools-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir,
        getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const captured = await store.capture({ text: "alpha ROOT_CAUSE omega", toolCallId: "call", toolName: "mcp__x__y" });
      if (!("reference" in captured)) throw new Error("capture failed");
      const [readTool, searchTool] = createToolResultArtifactTools(store);

      const read = await readTool.execute("read", { artifact_id: captured.reference.id, offset: 6, limit: 10 }, undefined, undefined, undefined);
      expect(read.content[0]).toMatchObject({ type: "text" });
      expect((read.content[0] as any).text).toContain("ROOT_CAUS");

      const search = await searchTool.execute("search", { artifact_id: captured.reference.id, query: "root_cause" }, undefined, undefined, undefined);
      expect((search.content[0] as any).text).toContain("ROOT_CAUSE");
      expect((readTool.parameters as any).properties).not.toHaveProperty("path");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("puts the no-match reading in front of the model, not just in the return type", async () => {
    // The diagnosis only counts if it reaches the tool's rendered text — that is the whole
    // surface the model sees. Asserting the internal shape alone would pass with the field
    // never rendered.
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-nomatch-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir,
        getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const captured = await store.capture({
        text: JSON.stringify({ entries: [{ user: "yhli", action: "delete" }] }),
        toolCallId: "call", toolName: "mcp__x__y",
      });
      if (!("reference" in captured)) throw new Error("capture failed");
      const [, searchTool] = createToolResultArtifactTools(store);

      // The literal an agent actually tried, from a trace: the words are all there, the
      // spelling is not, because the artifact stores them escaped.
      // Both words are stored, but not with a space after the colon — the miss is the spelling.
      const miss = await searchTool.execute(
        "search", { artifact_id: captured.reference.id, query: '"user": "yhli"' }, undefined, undefined, undefined);
      const parsed = JSON.parse((miss.content[0] as any).text as string);
      expect(parsed.matches).toEqual([]);
      expect(parsed.no_match.absentParts).toEqual([]);
      expect(parsed.no_match.reading).toMatch(/SPELLING is what failed/);

      // A hit carries no diagnosis — it would be noise on every successful search.
      const hit = await searchTool.execute(
        "search", { artifact_id: captured.reference.id, query: "yhli" }, undefined, undefined, undefined);
      expect(JSON.parse((hit.content[0] as any).text)).not.toHaveProperty("no_match");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("answers several distinct literals in one call, grouped per query", async () => {
    // The shape from the traces: five different terms against one 4-million-character artifact,
    // all hitting, spread over three or four model turns because each needed its own call.
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-batch-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir, getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const captured = await store.capture({
        text: "alpha here\nthen credit_balance_exhausted\nand gpt-5.6-sol@example\n",
        toolCallId: "call", toolName: "mcp__x__y",
      });
      if (!("reference" in captured)) throw new Error("capture failed");
      const [, searchTool] = createToolResultArtifactTools(store);

      const res = await searchTool.execute("search", {
        artifact_id: captured.reference.id,
        query: ["credit_balance_exhausted", "gpt-5.6-sol@example", "nowhere-to-be-found"],
      }, undefined, undefined, undefined);
      const parsed = JSON.parse((res.content[0] as any).text);

      expect(parsed.results.map((r: any) => r.query)).toEqual([
        "credit_balance_exhausted", "gpt-5.6-sol@example", "nowhere-to-be-found",
      ]);
      expect(parsed.results[0].matches).toHaveLength(1);
      expect(parsed.results[1].matches).toHaveLength(1);
      // A miss inside a batch still explains itself, exactly like a single-query miss.
      expect(parsed.results[2].matches).toEqual([]);
      expect(parsed.results[2].no_match.reading).toBeTruthy();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("a single literal keeps the flat response, so the common case does not change", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-single-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir, getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const captured = await store.capture({ text: "alpha NEEDLE omega", toolCallId: "c", toolName: "t" });
      if (!("reference" in captured)) throw new Error("capture failed");
      const [, searchTool] = createToolResultArtifactTools(store);
      const res = await searchTool.execute(
        "search", { artifact_id: captured.reference.id, query: "needle" }, undefined, undefined, undefined);
      const parsed = JSON.parse((res.content[0] as any).text);
      expect(parsed.query).toBe("needle");
      expect(parsed.matches).toHaveLength(1);
      expect(parsed).not.toHaveProperty("results");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("sheds matches fairly, never reporting a query that HIT as having found nothing", async () => {
    // The single-query renderer trims the end of one list. Across several that spends the whole
    // allowance on the first query and hands back the last with an empty `matches` — which reads
    // as "not in the artifact". That is a false answer, not a short one.
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-fair-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir, getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      // The budget must actually be exceeded or the shedding loop never runs and the test is
      // vacuous — which is what the first version of it was. 3 queries x 20 matches x ~4k of
      // snippet is ~240k against a 32k ceiling, so shedding is forced.
      const filler = "z".repeat(3_000);
      const text = Array.from({ length: 40 }, () => `${filler} AAA ${filler} BBB ${filler} CCC`).join("\n");
      const captured = await store.capture({ text, toolCallId: "c", toolName: "t" });
      if (!("reference" in captured)) throw new Error("capture failed");
      const [, searchTool] = createToolResultArtifactTools(store);

      const res = await searchTool.execute("search", {
        artifact_id: captured.reference.id, query: ["AAA", "BBB", "CCC"],
        context_chars: 2_000, max_matches: 20,
      }, undefined, undefined, undefined);
      const text_ = (res.content[0] as any).text as string;
      const parsed = JSON.parse(text_);
      expect(text_.length).toBeLessThanOrEqual(32_000);
      // The point: the LAST query still carries evidence, not an empty list.
      for (const result of parsed.results) {
        expect(result.matches.length).toBeGreaterThan(0);
        expect(result).not.toHaveProperty("no_match");
      }
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps the serialized search response within the tool output bound", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-tool-result-search-bound-"));
    try {
      const store = new ToolResultArtifactStore({
        rootDir,
        getScope: () => ({ agentId: "agent", sessionId: "session" }),
      });
      const text = Array.from({ length: 60 }, (_, i) => `${"x".repeat(2_000)} NEEDLE-${i} ${"y".repeat(2_000)}`).join("\n");
      const captured = await store.capture({ text, toolCallId: "call", toolName: "mcp__x__y" });
      if (!("reference" in captured)) throw new Error("capture failed");
      const [, searchTool] = createToolResultArtifactTools(store);

      const result = await searchTool.execute("search", {
        artifact_id: captured.reference.id,
        query: "needle",
        context_chars: 2_000,
        max_matches: 50,
      }, undefined, undefined, undefined);
      const output = (result.content[0] as any).text;
      expect(output.length).toBeLessThanOrEqual(32_000);
      expect(JSON.parse(output).truncated).toBe(true);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe("isToolResultArtifactPath", () => {
  it("blocks the current session tree and sibling session trees", () => {
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/agent/sessions/s1/.tool-results")).toBe(true);
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/agent/sessions/s1/.tool-results/abc/tra_1.txt")).toBe(true);
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/agent/sessions/other/.tool-results/abc/tra_1.txt")).toBe(true);
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/agent/sessions/s1/session.jsonl")).toBe(false);
    expect(isToolResultArtifactPath("/app/.siclaw/user-data/memory/notes.md")).toBe(false);
  });
});

function artifactRef(sizeChars: number) {
  return {
    version: 1 as const,
    id: "tra_0123456789abcdef0123456789abcdef",
    sizeChars,
    sizeBytes: sizeChars,
    sha256: "a".repeat(64),
    createdAt: "2026-09-03T00:00:00.000Z",
    expiresAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("formatToolResultArtifactReference", () => {
  it("keeps the artifact id, digest, and bounded head/tail preview", () => {
    const text = `HEAD-${"m".repeat(2_000)}-TAIL`;
    const rendered = formatToolResultArtifactReference(artifactRef(text.length), text, 1_000);
    expect(rendered.length).toBeLessThanOrEqual(1_000);
    expect(rendered).toContain("tra_0123456789abcdef0123456789abcdef");
    expect(rendered).toContain("HEAD-");
    expect(rendered).toContain("-TAIL");
  });

  it("does not invert the bound when the tail budget is zero", () => {
    const text = "x".repeat(500_000);
    const rendered = formatToolResultArtifactReference(artifactRef(text.length), text, 396);
    expect(rendered.length).toBeLessThanOrEqual(396);
  });
});

describe("formatUnrecoverableToolResult", () => {
  it("keeps a bounded head and tail when the omitted portion cannot be recovered", () => {
    const text = `HEAD-${"m".repeat(50_000)}-TAIL_ERROR`;
    const rendered = formatUnrecoverableToolResult({
      version: 1,
      reason: "write_failed",
      sizeChars: text.length,
      sizeBytes: text.length,
    }, text, 1_000);
    expect(rendered.length).toBeLessThanOrEqual(1_000);
    expect(rendered).toContain("cannot be recovered");
    expect(rendered).toContain("HEAD-");
    expect(rendered).toContain("-TAIL_ERROR");
  });
});


describe("native read through artifact capture", () => {
  let cwd: string;
  let artifacts: ToolResultArtifactStore;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "siclaw-native-read-"));
    artifacts = new ToolResultArtifactStore({
      rootDir: path.join(cwd, "artifacts"),
      getScope: () => ({ agentId: "agent", sessionId: "session" }),
      // Reading an authorized file must not depend on artifact storage capacity.
      maxArtifactBytes: 1,
    });
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  function read() {
    return withToolResultArtifactCapture(createReadTool(cwd), artifacts, 4096);
  }

  it("returns a Skill over 8000 characters intact, including its middle", async () => {
    const content = `${"step: inspect evidence\n".repeat(230)}MANDATORY MIDDLE GUIDANCE\n${"步骤：验证证据\n".repeat(650)}`;
    expect(content.length).toBeGreaterThan(8000);
    await fs.writeFile(path.join(cwd, "SKILL.md"), content);
    const result = await read().execute("skill", { path: "SKILL.md" }, undefined, undefined, undefined);
    expect(result.content).toEqual([{ type: "text", text: content }]);
    expect(getToolResultArtifactReference(result.details)).toBeNull();
  });

  it.each([
    { title: "line limit", count: 2300, width: 10 },
    { title: "byte limit", count: 900, width: 100 },
  ])("preserves consecutive pages and native continuation at the $title", async ({ count, width }) => {
    const lines = Array.from({ length: count }, (_, index) => `${index + 1}: ${"x".repeat(width)}`);
    await fs.writeFile(path.join(cwd, "source.ts"), lines.join("\n"));
    const tool = read();
    let offset = 1;
    const collected: string[] = [];
    for (let page = 0; page < 10; page++) {
      const result = await tool.execute(`page-${page}`, { path: "source.ts", offset }, undefined, undefined, undefined);
      const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      expect(text).not.toContain("artifact_id:");
      expect(text).not.toContain("preview middle omitted");
      const notice = /\n\n\[Showing lines \d+-\d+ of \d+.*Use offset=(\d+) to continue\.\]$/;
      const match = text.match(notice);
      collected.push(...text.replace(notice, "").split("\n"));
      if (!match) break;
      const nextOffset = Number(match[1]);
      expect(nextOffset).toBeGreaterThan(offset);
      expect(collected).toEqual(lines.slice(0, nextOffset - 1));
      offset = nextOffset;
    }
    expect(offset).toBeGreaterThan(1);
    expect(collected).toEqual(lines);
  });

  it("retains explicit line ranges and continuation notices", async () => {
    await fs.writeFile(path.join(cwd, "source.ts"), "one\ntwo\nthree\nfour");
    const result = await read().execute("range", { path: "source.ts", offset: 2, limit: 2 }, undefined, undefined, undefined);
    expect(result.content).toEqual([{ type: "text", text: "two\nthree\n\n[1 more lines in file. Use offset=4 to continue.]" }]);
  });

  it("keeps the injected file access restriction in effect", async () => {
    const tool = createReadTool(cwd, {
      operations: {
        access: async () => { throw new Error("read denied by path policy"); },
        readFile: async () => { throw new Error("must not read a denied file"); },
      },
    });
    const wrapped = withToolResultArtifactCapture(tool, artifacts, 4096);
    await expect(wrapped.execute("denied", { path: "private.txt" }, undefined, undefined, undefined))
      .rejects.toThrow("read denied by path policy");
  });
});


describe("a search that found nothing says which of the two reasons it was", () => {
  // An empty `matches` was the whole answer, and it has two causes the caller cannot tell
  // apart: the text is absent, or it is present in a spelling the literal missed. The traces
  // show which one the agent assumes — it rewrites the literal. One searches `"user":"yhli"`
  // then `user=yhli` on the same artifact; the reviews describe runs of 13 and 15 searches.

  it("says the spelling failed when every word IS there", () => {
    // Note the shape: `{"user":"yhli"}` CONTAINS `"user":"yhli"` literally, so that search hits.
    // The miss comes from a real difference — here the whitespace after the colon.
    const text = JSON.stringify({ entries: [{ user: "yhli", action: "delete" }] });
    const d = diagnoseNoMatch(text, '"user": "yhli"');
    expect(d.absentParts).toEqual([]);
    expect(d.presentParts).toEqual(expect.arrayContaining(["user", "yhli"]));
    expect(d.reading).toMatch(/SPELLING is what failed/);
    // It must NOT pick a cause: separator, whitespace and escaping are indistinguishable from
    // out here, and naming the wrong one sends the caller rewriting in the wrong direction.
    expect(d.reading).toMatch(/Search ONE word on its own/);
  });

  it("names the absent words, which is what ends the rewriting", () => {
    const text = JSON.stringify({ entries: [{ user: "yhli" }] });
    const d = diagnoseNoMatch(text, "user=zzztop");
    expect(d.presentParts).toContain("user");
    expect(d.absentParts).toContain("zzztop");
    // A fact about the ARTIFACT, not the query: no rewriting can find it.
    expect(d.reading).toMatch(/Absent: zzztop/);
  });

  it("says so when nothing in the query appears at all", () => {
    const d = diagnoseNoMatch("kubelet is healthy", "postgres connection pool");
    expect(d.presentParts).toEqual([]);
    expect(d.reading).toMatch(/does not carry the subject/);
  });

  it("reports the content type as a fact without letting it invent a cause", () => {
    expect(diagnoseNoMatch("plain log line with user yhli", '"user":"yhli"').contentIsJson).toBe(false);
    expect(diagnoseNoMatch(JSON.stringify({ user: "yhli" }), "nothing-here").contentIsJson).toBe(true);
  });

  it("handles a punctuation-only query without pretending to have checked parts", () => {
    const d = diagnoseNoMatch("{}", "=>");
    expect(d.presentParts).toEqual([]);
    expect(d.absentParts).toEqual([]);
    expect(d.reading).toMatch(/punctuation only/);
  });
});
