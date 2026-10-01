import { describe, expect, it } from "vitest";
import { LIMITS, parseTicketWatchResult, STATES } from "./result.js";

/** The minimum a run must submit: where it stands, and when to wake it. */
function quietTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: "watching", next_check_after_seconds: 300, ...overrides };
}

describe("a turn that did nothing", () => {
  // The single most important property of this contract. A follower is silent
  // most of the time; if the protocol could not express that, every quiet turn
  // would have to invent content to be accepted.
  it("is a complete, legal result", () => {
    expect(parseTicketWatchResult(quietTurn())).toEqual({
      state: "watching",
      next_check_after_seconds: 300,
    });
  });

  it("leaves every stored field alone by omitting it", () => {
    const parsed = parseTicketWatchResult(quietTurn());
    expect("understanding" in parsed).toBe(false);
    expect("last_seen_message_id" in parsed).toBe(false);
    expect("open_sre_tasks" in parsed).toBe(false);
    expect("note" in parsed).toBe(false);
  });

  it("may still say why it did nothing", () => {
    expect(parseTicketWatchResult(quietTurn({ note: "群里无新消息，排障仍在跑" })).note).toBe(
      "群里无新消息，排障仍在跑",
    );
  });
});

describe("state", () => {
  it("accepts each state the assistant may declare", () => {
    for (const state of STATES) {
      const input = state === "done" ? { state, note: "工单已结单" } : quietTurn({ state });
      expect(parseTicketWatchResult(input).state).toBe(state);
    }
  });

  it("is required", () => {
    expect(() => parseTicketWatchResult({ next_check_after_seconds: 300 })).toThrow(
      "input.state is required",
    );
  });

  // "stalled" exists in the harness but is its verdict after repeated failures,
  // not a self-assessment. The refusal has to teach that, or the model will
  // simply try a synonym next turn.
  it("refuses stalled and explains whose verdict it is", () => {
    expect(() => parseTicketWatchResult(quietTurn({ state: "stalled" }))).toThrow(
      /harness's verdict/,
    );
  });

  it("refuses an invented state", () => {
    for (const state of ["blocked", "WATCHING", "", 1]) {
      expect(() => parseTicketWatchResult(quietTurn({ state }))).toThrow("input.state must be one of");
    }
  });
});

describe("the schedule", () => {
  it("is required while the follow continues", () => {
    expect(() => parseTicketWatchResult({ state: "waiting_sre" })).toThrow(
      "input.next_check_after_seconds is required",
    );
  });

  it("is bounded at both ends", () => {
    expect(parseTicketWatchResult(quietTurn({ next_check_after_seconds: LIMITS.minCheckAfterSeconds }))
      .next_check_after_seconds).toBe(LIMITS.minCheckAfterSeconds);
    expect(parseTicketWatchResult(quietTurn({ next_check_after_seconds: LIMITS.maxCheckAfterSeconds }))
      .next_check_after_seconds).toBe(LIMITS.maxCheckAfterSeconds);
    for (const seconds of [0, 59, 3601, -300]) {
      expect(() => parseTicketWatchResult(quietTurn({ next_check_after_seconds: seconds }))).toThrow(
        "must be between",
      );
    }
  });

  it("must be a whole number of seconds", () => {
    for (const seconds of [300.5, "300", null]) {
      expect(() => parseTicketWatchResult(quietTurn({ next_check_after_seconds: seconds }))).toThrow();
    }
  });

  // A finished follow that also asks to be woken is a contradiction the worker
  // would have to resolve by guessing which half to believe.
  it("is dropped once the follow is done, not refused", () => {
    expect(parseTicketWatchResult({ state: "done", note: "已结单", next_check_after_seconds: 300 })).toEqual({
      state: "done",
      note: "已结单",
    });
  });

  it("is what a done result carries instead — a reason", () => {
    expect(() => parseTicketWatchResult({ state: "done" })).toThrow(
      'input.note is required when state is "done"',
    );
    expect(parseTicketWatchResult({ state: "done", note: "SRE 已结单，客户已验收" })).toEqual({
      state: "done",
      note: "SRE 已结单，客户已验收",
    });
  });
});

describe("understanding", () => {
  it("replaces the fields it carries and says nothing about the rest", () => {
    const parsed = parseTicketWatchResult(
      quietTurn({ understanding: { timeline: "13:50 起海外 MaaS API 报 404，三次复现" } }),
    );
    expect(parsed.understanding).toEqual({ timeline: "13:50 起海外 MaaS API 报 404，三次复现" });
    expect("ruled_out" in parsed.understanding!).toBe(false);
  });

  it("accepts an empty object, which changes nothing", () => {
    expect(parseTicketWatchResult(quietTurn({ understanding: {} })).understanding).toEqual({});
  });

  // A list replaces its whole value, so [] genuinely means "no longer anything"
  // — distinct from omitting the field, which means "do not touch it".
  it("accepts an empty list as a real retraction", () => {
    const parsed = parseTicketWatchResult(quietTurn({ understanding: { ruled_out: [] } }));
    expect(parsed.understanding).toEqual({ ruled_out: [] });
  });

  it("refuses null instead of guessing which it meant", () => {
    for (const key of ["understanding", "open_sre_tasks", "note", "last_seen_message_id"]) {
      expect(() => parseTicketWatchResult(quietTurn({ [key]: null }))).toThrow(
        `input.${key} must not be null`,
      );
    }
  });

  it("refuses a field the harness does not store", () => {
    expect(() => parseTicketWatchResult(quietTurn({ understanding: { hypothesis: "网关" } }))).toThrow(
      "input.understanding.hypothesis is not allowed",
    );
  });

  it("bounds each field so the next run inherits something readable", () => {
    expect(() =>
      parseTicketWatchResult(quietTurn({ understanding: { timeline: "国".repeat(LIMITS.timelineMaxChars) } })),
    ).not.toThrow();
    expect(() =>
      parseTicketWatchResult(
        quietTurn({ understanding: { timeline: "国".repeat(LIMITS.timelineMaxChars + 1) } }),
      ),
    ).toThrow(`must be at most ${LIMITS.timelineMaxChars} characters`);
    const many = Array.from({ length: LIMITS.maxListItems + 1 }, (_, i) => `问题 ${i}`);
    expect(() => parseTicketWatchResult(quietTurn({ understanding: { open_questions: many } }))).toThrow(
      `must have at most ${LIMITS.maxListItems} entries`,
    );
  });

  it("rejects blank entries rather than storing an empty line", () => {
    expect(() => parseTicketWatchResult(quietTurn({ understanding: { open_questions: ["  "] } }))).toThrow(
      "input.understanding.open_questions[0] must not be blank",
    );
    expect(() => parseTicketWatchResult(quietTurn({ understanding: { timeline: "   " } }))).toThrow(
      "input.understanding.timeline must not be blank",
    );
  });

  it("trims what it stores", () => {
    const parsed = parseTicketWatchResult(
      quietTurn({ understanding: { from_l1: ["  这个客户是 VIP，优先级提高  "] } }),
    );
    expect(parsed.understanding?.from_l1).toEqual(["这个客户是 VIP，优先级提高"]);
  });
});

describe("ruled_out", () => {
  const entry = { claim: "网关不健康", by_task: "task-abc" };

  it("keeps the claim with the task that established it", () => {
    const parsed = parseTicketWatchResult(quietTurn({ understanding: { ruled_out: [entry] } }));
    expect(parsed.understanding?.ruled_out).toEqual([entry]);
  });

  // The rule the whole contract exists for: the assistant may not exclude a
  // cause on its own reading, and the refusal has to point at where such a
  // belief does belong, or it will come back next turn as a timeline sentence.
  it("refuses an exclusion with no investigation behind it", () => {
    expect(() =>
      parseTicketWatchResult(quietTurn({ understanding: { ruled_out: [{ claim: "网关不健康" }] } })),
    ).toThrow(/by_task is required/);
    expect(() =>
      parseTicketWatchResult(quietTurn({ understanding: { ruled_out: [{ claim: "网关不健康" }] } })),
    ).toThrow(/open_questions/);
  });

  it("refuses a blank citation, which is the same claim with a formality", () => {
    for (const by_task of ["", "   "]) {
      expect(() =>
        parseTicketWatchResult(quietTurn({ understanding: { ruled_out: [{ claim: "网关不健康", by_task }] } })),
      ).toThrow("must not be blank");
    }
  });

  it("requires the claim itself", () => {
    expect(() =>
      parseTicketWatchResult(quietTurn({ understanding: { ruled_out: [{ by_task: "task-abc" }] } })),
    ).toThrow("claim is required");
  });

  it("refuses an extra field on an entry", () => {
    expect(() =>
      parseTicketWatchResult(
        quietTurn({ understanding: { ruled_out: [{ ...entry, confidence: "high" }] } }),
      ),
    ).toThrow("input.understanding.ruled_out[0].confidence is not allowed");
  });
});

describe("cursor and in-flight tasks", () => {
  it("advances the cursor only when a run says so", () => {
    expect(parseTicketWatchResult(quietTurn({ last_seen_message_id: "1047" })).last_seen_message_id).toBe(
      "1047",
    );
    expect("last_seen_message_id" in parseTicketWatchResult(quietTurn())).toBe(false);
  });

  it("takes the open task list as a whole, including empty", () => {
    expect(parseTicketWatchResult(quietTurn({ open_sre_tasks: [] })).open_sre_tasks).toEqual([]);
    expect(
      parseTicketWatchResult(quietTurn({ open_sre_tasks: ["task-abc", "task-def"] })).open_sre_tasks,
    ).toEqual(["task-abc", "task-def"]);
  });

  it("refuses a repeated task id, which would double-count one investigation", () => {
    expect(() => parseTicketWatchResult(quietTurn({ open_sre_tasks: ["task-abc", "task-abc"] }))).toThrow(
      "must not repeat",
    );
  });

  it("bounds ids to the width the harness stores", () => {
    expect(() =>
      parseTicketWatchResult(quietTurn({ last_seen_message_id: "x".repeat(LIMITS.idMaxChars + 1) })),
    ).toThrow(`must be at most ${LIMITS.idMaxChars} characters`);
  });
});

describe("the envelope", () => {
  it("refuses a field nobody will read", () => {
    expect(() => parseTicketWatchResult(quietTurn({ reply_to_group: "已收到" }))).toThrow(
      "input.reply_to_group is not allowed",
    );
  });

  it("refuses a non-object input", () => {
    for (const input of [null, "watching", 1, [quietTurn()]]) {
      expect(() => parseTicketWatchResult(input)).toThrow("input must be an object");
    }
  });

  // Counted in code points, before trimming, so this parser is never more
  // lenient than the maxLength the model was shown.
  it("counts characters the way a reader would", () => {
    expect(() => parseTicketWatchResult(quietTurn({ note: "国".repeat(LIMITS.noteMaxChars) }))).not.toThrow();
    expect(() => parseTicketWatchResult(quietTurn({ note: ` ${"国".repeat(LIMITS.noteMaxChars)} ` }))).toThrow(
      `must be at most ${LIMITS.noteMaxChars} characters`,
    );
    expect(() => parseTicketWatchResult(quietTurn({ note: "𝄞".repeat(LIMITS.noteMaxChars) }))).not.toThrow();
  });
});

describe("closure", () => {
  it("carries the assistant's proposal for the ticket's closure fields", () => {
    const parsed = parseTicketWatchResult(
      quietTurn({
        closure: {
          modules: ["storage-object-upload", "billing"],
          description: " 客户在华东区上传对象到 bucket 时返回 403，自 14:00 起全部失败。 ",
          result_type: " 存储配额不足 ",
          result: "对象存储配额已用满，扩容后上传恢复。",
        },
      }),
    );
    expect(parsed.closure).toEqual({
      modules: ["storage-object-upload", "billing"],
      description: "客户在华东区上传对象到 bucket 时返回 403，自 14:00 起全部失败。",
      result_type: "存储配额不足",
      result: "对象存储配额已用满，扩容后上传恢复。",
    });
  });

  it("bounds the description like the pre-ticket assistant's, and keeps it multi-line", () => {
    const multiLine = "现象：推理 Pod Pending\n范围：siclaw-e2e-fixture 命名空间的 6 个副本";
    expect(parseTicketWatchResult(quietTurn({ closure: { description: multiLine } })).closure).toEqual({
      description: multiLine,
    });
    expect(() => parseTicketWatchResult(quietTurn({ closure: { description: "  " } }))).toThrow(
      "input.closure.description must not be blank",
    );
    expect(() => parseTicketWatchResult(quietTurn({ closure: { description: null } }))).toThrow(
      "input.closure.description must not be null",
    );
    expect(() =>
      parseTicketWatchResult(
        quietTurn({ closure: { description: "象".repeat(LIMITS.descriptionMaxChars + 1) } }),
      ),
    ).toThrow(`at most ${LIMITS.descriptionMaxChars} characters`);
  });

  it("replaces only the fields it names, and an empty proposal changes nothing", () => {
    expect(parseTicketWatchResult(quietTurn({ closure: { modules: ["billing"] } })).closure).toEqual({
      modules: ["billing"],
    });
    expect(parseTicketWatchResult(quietTurn({ closure: {} })).closure).toEqual({});
    expect("closure" in parseTicketWatchResult(quietTurn())).toBe(false);
  });

  it("lets modules be emptied, since [] is a real retraction", () => {
    expect(parseTicketWatchResult(quietTurn({ closure: { modules: [] } })).closure).toEqual({ modules: [] });
  });

  it("takes module ids in the channel's own form only", () => {
    for (const bad of ["Billing", "storage object", "1st-level", "-billing", "对象存储", " billing "]) {
      expect(() => parseTicketWatchResult(quietTurn({ closure: { modules: ["billing", bad] } }))).toThrow(
        "input.closure.modules[1] must be a module_id",
      );
    }
    expect(() => parseTicketWatchResult(quietTurn({ closure: { modules: ["billing", "billing"] } }))).toThrow(
      "must not repeat a module_id",
    );
    expect(() =>
      parseTicketWatchResult(
        quietTurn({ closure: { modules: Array.from({ length: LIMITS.maxModules + 1 }, (_, i) => `module-${i}`) } }),
      ),
    ).toThrow(`at most ${LIMITS.maxModules} entries`);
  });

  it("keeps result_type to one line and refuses blank or null fields", () => {
    expect(() => parseTicketWatchResult(quietTurn({ closure: { result_type: "网络\n故障" } }))).toThrow(
      "input.closure.result_type must be a single line",
    );
    expect(() => parseTicketWatchResult(quietTurn({ closure: { result: "  " } }))).toThrow(
      "input.closure.result must not be blank",
    );
    expect(() => parseTicketWatchResult(quietTurn({ closure: { result_type: null } }))).toThrow(
      "input.closure.result_type must not be null",
    );
    expect(() => parseTicketWatchResult(quietTurn({ closure: { status: "resolved" } }))).toThrow(
      "input.closure.status is not allowed",
    );
    expect(() =>
      parseTicketWatchResult(quietTurn({ closure: { result: "因".repeat(LIMITS.resultMaxChars + 1) } })),
    ).toThrow(`at most ${LIMITS.resultMaxChars} characters`);
  });
});
