import { describe, expect, it, vi } from "vitest";
import { CodexUserInput } from "./codex-user-input.js";

describe("native user questions", () => {
  const options = () => ({ active: () => ({ threadId: "root", turnId: "turn" }),
    redact: (value: string) => value.replaceAll("owner-token", "[REDACTED]"), show: vi.fn() });
  const question = { id: "scope", header: "Target", question: "Choose the target", options: [{ label: "Test", description: "Read test only" }, { label: "Prod", description: "Read production" }] };
  it("maps an ordinary chat answer to the native answer without granting execution", async () => {
    const opts = options(), broker = new CodexUserInput(opts);
    const result = broker.request({ threadId: "root", turnId: "turn", questions: [question] });
    expect(opts.show).toHaveBeenCalledWith(expect.stringContaining("A. Test"), [question], expect.objectContaining({ engine: "codex", requestId: expect.any(String), questions: [question] }));
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

  it("accepts structured answers once, including several questions and free text", async () => {
    const opts = { ...options(), resolved: vi.fn() }, broker = new CodexUserInput(opts);
    const result = broker.request({ threadId: "root", turnId: "turn", questions: [question, { ...question, id: "notes", options: undefined }] });
    const request = broker.snapshot()!;
    const answer = { requestId: request.requestId, answers: { scope: "Prod", notes: "owner-token" } };
    expect(broker.prepare(answer).alreadyAccepted).toBe(false);
    expect(broker.snapshot()?.requestId).toBe(request.requestId);
    expect(opts.resolved).not.toHaveBeenCalled();
    expect(broker.submit(answer)).toEqual({ text: "Target: Prod\nTarget: [REDACTED]", alreadyAccepted: false });
    expect(await result).toEqual({ answers: { scope: { answers: ["Prod"] }, notes: { answers: ["[REDACTED]"] } } });
    expect(broker.submit(answer).alreadyAccepted).toBe(true);
    expect(opts.resolved).toHaveBeenCalledTimes(1);
    expect(broker.snapshot()).toBeUndefined();
    expect(() => broker.submit({ ...answer, answers: { ...answer.answers, notes: "different" } })).toThrow("USER_INPUT_INVALID");
  });

  it("rejects stale IDs, missing/extra answers, changed turns and answers after Stop", async () => {
    let turnId = "turn";
    const broker = new CodexUserInput({ ...options(), active: () => ({ threadId: "root", turnId }) });
    const result = broker.request({ threadId: "root", turnId, questions: [question] });
    const request = broker.snapshot()!;
    for (const answer of [{ requestId: "old", answers: { scope: "Test" } }, { requestId: request.requestId, answers: { unknown: "Test" } },
      { requestId: request.requestId, answers: { scope: "Test", unknown: "Test" } }]) expect(() => broker.submit(answer)).toThrow();
    turnId = "next";
    expect(broker.snapshot()).toBeUndefined();
    expect(() => broker.submit({ requestId: request.requestId, answers: { scope: "Test" } })).toThrow("USER_INPUT_EXPIRED");
    broker.cancel(); await result;
    expect(() => broker.submit({ requestId: request.requestId, answers: { scope: "Test" } })).toThrow("USER_INPUT_EXPIRED");
  });

  it("does not expose mutable internal question state", async () => {
    const broker = new CodexUserInput(options());
    const result = broker.request({ threadId: "root", turnId: "turn", questions: [question] });
    const request = broker.snapshot()!;
    request.questions[0].options![0].label = "changed";
    expect(broker.snapshot()!.questions[0].options![0].label).toBe("Test");
    broker.cancel(); await result;
  });
  it("skips an exact current question without choosing an option or aborting the turn", async () => {
    const broker = new CodexUserInput(options());
    const result = broker.request({ threadId: "root", turnId: "turn", questions: [question] });
    const answer = { requestId: broker.snapshot()!.requestId, answers: {}, skip: true };
    expect(broker.prepare(answer).text).toBe("Skipped question");
    expect(broker.snapshot()).toBeDefined();
    broker.submit(answer);
    expect(await result).toEqual({ answers: {} });
    expect(broker.submit(answer).alreadyAccepted).toBe(true);
  });
});
