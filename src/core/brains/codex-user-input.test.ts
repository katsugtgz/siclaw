import { describe, expect, it, vi } from "vitest";
import { CodexUserInput } from "./codex-user-input.js";

describe("native user questions", () => {
  const options = () => ({ active: () => ({ threadId: "root", turnId: "turn" }),
    redact: (value: string) => value.replaceAll("owner-token", "[REDACTED]"), show: vi.fn() });
  const question = { id: "scope", header: "Target", question: "Choose the target", options: [{ label: "Test", description: "Read test only" }, { label: "Prod", description: "Read production" }] };
  it("maps an ordinary chat answer to the native answer without granting execution", async () => {
    const opts = options(), broker = new CodexUserInput(opts);
    const result = broker.request({ threadId: "root", turnId: "turn", questions: [question] });
    expect(opts.show).toHaveBeenCalledWith(expect.stringContaining("A. Test"), [question]);
    expect(broker.answer("A")).toBe(true);
    expect(await result).toEqual({ answers: { scope: { answers: ["Test"] } } });
    expect(broker.answer("A")).toBe(false);
  });
  it("requires each numbered answer and sanitizes answers", async () => {
    const broker = new CodexUserInput(options());
    const result = broker.request({ threadId: "root", turnId: "turn", questions: [question, { ...question, id: "when" }] });
    expect(() => broker.answer("A")).toThrow("each numbered");
    broker.answer("1: B\n2: owner-token");
    expect(await result).toEqual({ answers: { scope: { answers: ["Prod"] }, when: { answers: ["[REDACTED]"] } } });
  });
  it("rejects another thread, stale turn, duplicate IDs and credential questions", async () => {
    const broker = new CodexUserInput(options());
    for (const params of [{ threadId: "child", turnId: "turn", questions: [question] },
      { threadId: "root", turnId: "old", questions: [question] }, { threadId: "root", turnId: "turn", questions: [question, question] },
      { threadId: "root", turnId: "turn", questions: [{ ...question, isSecret: true }] }]) await expect(broker.request(params)).rejects.toThrow();
  });
  it("cancels a pending request and rejects overlapping questions", async () => {
    const broker = new CodexUserInput(options());
    const params = { threadId: "root", turnId: "turn", questions: [question] };
    const result = broker.request(params);
    await expect(broker.request(params)).rejects.toThrow();
    broker.cancel(); expect(await result).toEqual({ answers: {} });
    expect(broker.answer("late answer")).toBe(false);
  });
});
