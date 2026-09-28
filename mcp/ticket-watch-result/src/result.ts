/**
 * One turn's receipt from the assistant that follows an L1 ticket.
 *
 * The harness is stateful and the agent is not: every run starts from nothing,
 * is handed the row, and ends. This result IS the handover — the only thing a
 * run leaves behind. Design: workspace-materials/design/siticket-l1-assistant-*
 * (HARNESS.md §5 and §7).
 *
 * Three properties the shape is built around:
 *
 * 1. **A turn that did nothing is a first-class result.** Most of the time the
 *    correct behaviour of a follower is to stay quiet — nothing new in the
 *    group, an investigation still running. `state` plus a schedule is a
 *    complete submission; every other field may be omitted. A contract that
 *    forced a narrative every turn would get one invented.
 *
 * 2. **Field-level replace, mirroring Siticket's own `update_for_ai`**, which
 *    the team already knows: a field present replaces that field, a field
 *    absent leaves it alone, and there is no merge inside a field. So the agent
 *    re-curates what it wants to keep instead of appending forever, which is
 *    also what keeps the injected context flat as a ticket ages.
 *
 * 3. **Nothing is ruled out without a task that ruled it out.** See `ruled_out`.
 *
 * This module validates shape, bounds and the few relationships between fields.
 * It does not know whether the ticket exists, whether the timeline is true, or
 * whether a cited task ever ran — those come from the run this result was drawn
 * from and from the harness that stores it.
 */

/**
 * States the assistant may declare for its own follow.
 *
 * `stalled` is deliberately NOT here although HARNESS.md §3 lists it: it is the
 * harness's verdict after five consecutive failed runs, not a self-assessment.
 * A run that believes it is stuck is still watching, and says why in `note`.
 */
export const STATES = ["watching", "waiting_sre", "waiting_l1", "done"] as const;
export type WatchState = (typeof STATES)[number];

/**
 * Bounds. Each is a re-curation budget rather than a storage limit — the row is
 * a JSON column and could hold far more. Worst case here is roughly 11.6K
 * characters, so no global serialized cap is needed on top.
 *
 * Oversized input is REJECTED, never truncated: the agent can shorten its own
 * text, whereas a silent clip would drop the end of a timeline without telling
 * anyone and the next run would inherit the damage as fact.
 */
export const LIMITS = {
  /** Matches `siclaw_ticket_watches.next_check_at` cadence bounds (HARNESS.md §3). */
  minCheckAfterSeconds: 60,
  maxCheckAfterSeconds: 3600,
  /** Matches the varchar(64) columns the harness stores these in. */
  idMaxChars: 64,
  maxOpenTasks: 10,
  timelineMaxChars: 1500,
  claimMaxChars: 300,
  listItemMaxChars: 300,
  maxListItems: 10,
  noteMaxChars: 500,
  /** The ticket channel's module_id column and its tag budget. */
  moduleIdMaxChars: 64,
  maxModules: 10,
  /** Siticket's result_type is a single-line category; result is free text. */
  resultTypeMaxChars: 100,
  resultMaxChars: 2000,
} as const;

/** The ticket channel's own module_id rule. Existence is the harness's and the channel's check. */
export const MODULE_ID_PATTERN = "^[a-z][a-z0-9_-]*$";
const MODULE_ID_RE = new RegExp(MODULE_ID_PATTERN);

/** One thing an investigation established is NOT the cause. */
export interface RuledOut {
  claim: string;
  /** The SRE task that concluded it. Never the assistant's own judgement. */
  by_task: string;
}

/**
 * What the assistant currently believes. The only thing we store, and what the
 * next run — possibly in a fresh session, possibly two days later — is handed
 * as its entire background.
 */
export interface Understanding {
  timeline?: string;
  ruled_out?: RuledOut[];
  open_questions?: string[];
  from_l1?: string[];
}

/**
 * The assistant's current proposal for the ticket's closure fields — what the
 * engineer will be asked to confirm when they mark the ticket resolved.
 *
 * Same field-level replace as `understanding`: a field present replaces the
 * previous proposal for it, a field absent keeps it. The harness writes the
 * ticket; this tool writes nothing and cannot tell whether a person has since
 * edited a field, which is exactly why the write is not the model's to make.
 */
export interface Closure {
  modules?: string[];
  result_type?: string;
  result?: string;
}

export interface TicketWatchResult {
  state: WatchState;
  next_check_after_seconds?: number;
  last_seen_message_id?: string;
  open_sre_tasks?: string[];
  understanding?: Understanding;
  closure?: Closure;
  note?: string;
}

const TOP_KEYS = new Set<keyof TicketWatchResult>([
  "state",
  "next_check_after_seconds",
  "last_seen_message_id",
  "open_sre_tasks",
  "understanding",
  "closure",
  "note",
]);

const CLOSURE_KEYS = new Set<keyof Closure>(["modules", "result_type", "result"]);

const UNDERSTANDING_KEYS = new Set<keyof Understanding>([
  "timeline",
  "ruled_out",
  "open_questions",
  "from_l1",
]);

function rejectUnknownKeys(record: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${path}.${key} is not allowed`);
    }
  }
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readText(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  // Counted on the RAW value, in code points, so this parser is never more
  // lenient than the advertised maxLength a host applies before dispatch, and
  // so a CJK timeline is measured the way a reader would count it.
  if ([...value].length > maxChars) {
    throw new Error(`${path} must be at most ${maxChars} characters`);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new Error(`${path} must not be blank`);
  }
  return text;
}

const RULED_OUT_KEYS = new Set(["claim", "by_task"]);

/**
 * Reads an array field. A list replaces its whole value, so `[]` is meaningful
 * — "nothing is ruled out any more", "no investigation is in flight" — and is
 * accepted. Omitting the field is what leaves the stored value alone.
 */
function readArray(value: unknown, path: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`);
  }
  if (value.length > maxItems) {
    throw new Error(
      `${path} must have at most ${maxItems} entries; keep the ones that still matter`,
    );
  }
  return value;
}

function readTextList(value: unknown, path: string, maxChars: number): string[] {
  return readArray(value, path, LIMITS.maxListItems).map((item, index) =>
    readText(item, `${path}[${index}]`, maxChars),
  );
}

function readRuledOut(value: unknown, path: string): RuledOut[] {
  return readArray(value, path, LIMITS.maxListItems).map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const record = readObject(item, itemPath);
    rejectUnknownKeys(record, RULED_OUT_KEYS, itemPath);
    if (!("claim" in record)) throw new Error(`${itemPath}.claim is required`);
    // The rule this whole contract exists to enforce. A confident wrong
    // exclusion is far more damaging than a missing fact: the investigator
    // cannot see where it came from and has no reason to doubt a claim the
    // brief states plainly. Anything merely believed goes in `open_questions`.
    //
    // What this check CAN do is make the citation structural — the agent cannot
    // rule something out without naming a task. What it cannot do is verify the
    // task said so, or that it exists; the tool holds no state. The harness is
    // where a cited id gets checked against this ticket's own task history.
    if (!("by_task" in record)) {
      throw new Error(
        `${itemPath}.by_task is required — only an investigation may rule something out. If this is your own reading, put it in understanding.open_questions instead.`,
      );
    }
    return {
      claim: readText(record.claim, `${itemPath}.claim`, LIMITS.claimMaxChars),
      by_task: readText(record.by_task, `${itemPath}.by_task`, LIMITS.idMaxChars),
    };
  });
}

function readUnderstanding(value: unknown): Understanding {
  const record = readObject(value, "input.understanding");
  rejectUnknownKeys(record, UNDERSTANDING_KEYS as Set<string>, "input.understanding");
  // An empty object is legal and changes nothing. Rejecting it would punish a
  // turn for being explicit about having learned nothing.
  const understanding: Understanding = {};
  if ("timeline" in record) {
    understanding.timeline = readText(
      record.timeline,
      "input.understanding.timeline",
      LIMITS.timelineMaxChars,
    );
  }
  if ("ruled_out" in record) {
    understanding.ruled_out = readRuledOut(record.ruled_out, "input.understanding.ruled_out");
  }
  if ("open_questions" in record) {
    understanding.open_questions = readTextList(
      record.open_questions,
      "input.understanding.open_questions",
      LIMITS.listItemMaxChars,
    );
  }
  if ("from_l1" in record) {
    understanding.from_l1 = readTextList(
      record.from_l1,
      "input.understanding.from_l1",
      LIMITS.listItemMaxChars,
    );
  }
  return understanding;
}

function readModules(value: unknown): string[] {
  const path = "input.closure.modules";
  const modules = readArray(value, path, LIMITS.maxModules).map((item, index) => {
    const id = readText(item, `${path}[${index}]`, LIMITS.moduleIdMaxChars);
    if (!MODULE_ID_RE.test(id)) {
      throw new Error(`${path}[${index}] must be a module_id from the ticket-modules skill: lowercase letters, digits, '-' or '_', starting with a letter`);
    }
    return id;
  });
  if (new Set(modules).size !== modules.length) {
    throw new Error(`${path} must not repeat a module_id`);
  }
  return modules;
}

function readClosure(value: unknown): Closure {
  const record = readObject(value, "input.closure");
  rejectUnknownKeys(record, CLOSURE_KEYS as Set<string>, "input.closure");
  for (const key of Object.keys(record)) {
    if (record[key] === null) {
      throw new Error(`input.closure.${key} must not be null; omit the field to keep your previous proposal`);
    }
  }
  // An empty object is legal and changes nothing, as with understanding.
  const closure: Closure = {};
  if ("modules" in record) {
    closure.modules = readModules(record.modules);
  }
  if ("result_type" in record) {
    const text = readText(record.result_type, "input.closure.result_type", LIMITS.resultTypeMaxChars);
    // The ticket shows it as one line in the resolve card; a multi-line value
    // would be flattened by whoever renders it next.
    if (/[\r\n]/.test(text)) {
      throw new Error("input.closure.result_type must be a single line");
    }
    closure.result_type = text;
  }
  if ("result" in record) {
    closure.result = readText(record.result, "input.closure.result", LIMITS.resultMaxChars);
  }
  return closure;
}

function readCheckAfterSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("input.next_check_after_seconds must be an integer number of seconds");
  }
  if (value < LIMITS.minCheckAfterSeconds || value > LIMITS.maxCheckAfterSeconds) {
    throw new Error(
      `input.next_check_after_seconds must be between ${LIMITS.minCheckAfterSeconds} and ${LIMITS.maxCheckAfterSeconds}`,
    );
  }
  return value;
}

function readOpenTasks(value: unknown): string[] {
  const tasks = readArray(value, "input.open_sre_tasks", LIMITS.maxOpenTasks).map((item, index) =>
    readText(item, `input.open_sre_tasks[${index}]`, LIMITS.idMaxChars),
  );
  if (new Set(tasks).size !== tasks.length) {
    throw new Error("input.open_sre_tasks must not repeat a task id");
  }
  return tasks;
}

/**
 * Validates one turn's result.
 *
 * A key that is present is used; a key that is absent leaves the stored value
 * alone. `null` is refused rather than read as either one — the difference
 * between "clear this" and "do not touch this" is exactly what the caller must
 * not have to guess.
 */
export function parseTicketWatchResult(input: unknown): TicketWatchResult {
  const record = readObject(input, "input");
  rejectUnknownKeys(record, TOP_KEYS as Set<string>, "input");

  for (const key of Object.keys(record)) {
    if (record[key] === null) {
      throw new Error(`input.${key} must not be null; omit the field to leave it unchanged`);
    }
  }

  if (!("state" in record)) {
    throw new Error("input.state is required");
  }
  if (typeof record.state !== "string" || !(STATES as readonly string[]).includes(record.state)) {
    const listed = STATES.join(", ");
    const hint =
      record.state === "stalled"
        ? ' — "stalled" is the harness\'s verdict after repeated failures, not one you declare; stay in "watching" and say why in `note`'
        : "";
    throw new Error(`input.state must be one of: ${listed}${hint}`);
  }
  const state = record.state as WatchState;

  const result: TicketWatchResult = { state };

  // `done` ends the follow, so a next check would be a contradiction rather
  // than a harmless extra: the worker would have to decide which of the two to
  // believe. Everywhere else the schedule is what the run is FOR.
  if (state === "done") {
    if ("next_check_after_seconds" in record) {
      throw new Error(
        'input.next_check_after_seconds must be omitted when state is "done" — a finished follow is not scheduled again',
      );
    }
    // The one transition a person reading the trail will want explained.
    if (!("note" in record)) {
      throw new Error('input.note is required when state is "done" — say why the follow ended');
    }
  } else {
    if (!("next_check_after_seconds" in record)) {
      throw new Error("input.next_check_after_seconds is required unless state is \"done\"");
    }
    result.next_check_after_seconds = readCheckAfterSeconds(record.next_check_after_seconds);
  }

  if ("last_seen_message_id" in record) {
    result.last_seen_message_id = readText(
      record.last_seen_message_id,
      "input.last_seen_message_id",
      LIMITS.idMaxChars,
    );
  }
  if ("open_sre_tasks" in record) {
    result.open_sre_tasks = readOpenTasks(record.open_sre_tasks);
  }
  if ("understanding" in record) {
    result.understanding = readUnderstanding(record.understanding);
  }
  if ("closure" in record) {
    result.closure = readClosure(record.closure);
  }
  if ("note" in record) {
    result.note = readText(record.note, "input.note", LIMITS.noteMaxChars);
  }

  return result;
}
