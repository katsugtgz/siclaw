/**
 * Closure summary for a ticket the customer resolved before human handoff.
 *
 * The consumer is Siticket's closure form, and the three fields ARE that form's
 * columns. Its labels switch by ticket type — for a fault: 故障类型 / 故障描述 /
 * 故障原因及处理操作; for a consultation: 咨询类型 / 咨询描述 / 解答说明 — but the
 * column names do not, which is why one shape serves both.
 *
 * `result_type` is a REQUIRED single-line free-text control, not an enum:
 * Siticket caps it server side with `utf8.RuneCountInString(value) > 256` and
 * publishes no value list. So this tool bounds the field and nothing more —
 * there is nothing to validate the wording against, and inventing a list here
 * would reject values the human form accepts. Shape guidance belongs in the
 * Agent prompt; the single-line rule is enforced here because the control
 * cannot render a newline.
 *
 * Nothing else is accepted. Siticket persists exactly these three fields, so a
 * fourth would have nowhere to go and would only invite the model to spend a
 * turn on it.
 */

/**
 * Character bounds. `resultTypeMaxChars` mirrors Siticket's own rune cap; the
 * other two are ours, chosen to keep one closure payload comfortably inside the
 * downstream result metadata while leaving room for a cause plus the actions
 * taken and how they were verified. Oversized fields are REJECTED rather than
 * truncated: the model can shorten its own text, whereas a silent clip would
 * drop the end of a causal explanation without telling anyone.
 */
export const LIMITS = {
  resultTypeMaxChars: 256,
  descriptionMaxChars: 2000,
  resultMaxChars: 4000,
} as const;

export interface TicketClosureResult {
  /** 工单背景信息 — the customer's need, established facts, affected module. */
  description: string;
  /** 故障类型 / 咨询类型 — a short concrete category, single line. */
  result_type: string;
  /** 故障原因及处理操作 / 解答说明 — cause and disposition, or the answer given. */
  result: string;
}

const KEYS = new Set<keyof TicketClosureResult>(["description", "result_type", "result"]);

// The control is a single-line input on both the Siticket Web dialog and the
// Feishu form. U+2028 / U+2029 are line terminators too and are rejected for
// the same reason, even though they survive a naive newline test. They are
// built from code points rather than written literally: both characters END A
// LINE in JavaScript source, so a literal one silently breaks the file.
const LINE_BREAKS = ["\r", "\n", String.fromCodePoint(0x2028), String.fromCodePoint(0x2029)];

function hasLineBreak(value: string): boolean {
  return LINE_BREAKS.some((character) => value.includes(character));
}

function readField(
  value: unknown,
  path: string,
  maxChars: number,
  options: { singleLine?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  // Counted on the RAW value, in code points, so this parser is never more
  // lenient than the advertised maxLength a host applies before dispatch, and
  // so the count matches Siticket's own rune-based check rather than UTF-16
  // units (a CJK summary would otherwise pass here and be refused there).
  if ([...value].length > maxChars) {
    throw new Error(`${path} must be at most ${maxChars} characters`);
  }
  if (options.singleLine && hasLineBreak(value)) {
    throw new Error(`${path} must be a single line without line breaks`);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new Error(`${path} must not be blank`);
  }
  return text;
}

/**
 * Validates shape and bounds. It does not establish that the ticket exists,
 * that the cause is correct, or that anything was actually done — those come
 * from the conversation this result was drawn from.
 */
export function parseTicketClosureResult(input: unknown): TicketClosureResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const record = input as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!KEYS.has(key as keyof TicketClosureResult)) {
      throw new Error(`input.${key} is not allowed`);
    }
  }
  for (const key of KEYS) {
    if (!(key in record)) {
      throw new Error(`input.${key} is required`);
    }
  }

  return {
    description: readField(
      record.description,
      "input.description",
      LIMITS.descriptionMaxChars,
    ),
    result_type: readField(record.result_type, "input.result_type", LIMITS.resultTypeMaxChars, {
      singleLine: true,
    }),
    result: readField(record.result, "input.result", LIMITS.resultMaxChars),
  };
}
