import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { claimSessionEngine, SessionEngineMismatchError } from "./session-engine.js";

const roots: string[] = [];
const directory = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-engine-")); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it("keeps Pi and Codex conversations independent and rejects cross-engine resume", () => {
  const pi = directory(), codex = directory();
  claimSessionEngine(pi, "pi-agent-id", "pi-chat", "pi-agent");
  claimSessionEngine(codex, "codex-agent-id", "codex-chat", "codex");
  expect(() => claimSessionEngine(pi, "pi-agent-id", "pi-chat", "pi-agent")).not.toThrow();
  expect(() => claimSessionEngine(codex, "codex-agent-id", "codex-chat", "pi-agent")).toThrow(SessionEngineMismatchError);
  expect(() => claimSessionEngine(pi, "another-agent", "pi-chat", "pi-agent")).toThrow(/ownership/);
});
it("preserves the legacy native marker instead of deleting it when Pi is selected", () => {
  const root = directory(); fs.writeFileSync(path.join(root, "codex-thread.json"), "legacy native history");
  expect(() => claimSessionEngine(root, "a", "s", "pi-agent")).toThrow(SessionEngineMismatchError);
  expect(fs.readFileSync(path.join(root, "codex-thread.json"), "utf8")).toBe("legacy native history");
  expect(() => claimSessionEngine(root, "a", "s", "codex")).not.toThrow();
});
it("does not reinterpret a legacy Pi transcript as native history", () => {
  const root = directory(); fs.writeFileSync(path.join(root, "old.jsonl"), "{}\n");
  expect(() => claimSessionEngine(root, "a", "s", "codex")).toThrow(SessionEngineMismatchError);
});
it("refuses redirected and malformed private markers", () => {
  const root = directory(), other = directory(), file = path.join(other, "marker");
  fs.writeFileSync(file, "unrelated"); fs.symlinkSync(file, path.join(root, "agent-engine.json"));
  expect(() => claimSessionEngine(root, "a", "s", "pi-agent")).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("unrelated");
  const malformed = directory(); fs.writeFileSync(path.join(malformed, "agent-engine.json"), "{}");
  expect(() => claimSessionEngine(malformed, "a", "s", "codex")).toThrow(/ownership/);
});
