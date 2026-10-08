import { createHash, randomUUID } from "node:crypto";
import { NativeUserInputError, type NativeUserInputQuestion, type NativeUserInputRequest,
  type NativeUserInputAnswer, type NativeUserInputAcceptance } from "../../shared/native-user-input.js";
type Question = NativeUserInputQuestion;
type Response = { answers: Record<string, { answers: string[] }> };

/** Answers travel through the existing authenticated chat/steer path. This
 * service never authorizes commands or handles credentials. */
export class CodexUserInput {
  private pending?: { requestId: string; questions: Question[]; turnId: string; resolve: (value: Response) => void };
  private accepted?: { requestId: string; digest: string; turnId: string; text: string };
  constructor(private readonly options: {
    active: () => { threadId: string; turnId: string } | undefined;
    redact: (text: string) => string;
    show: (text: string, questions: Question[], request: NativeUserInputRequest) => void;
    resolved?: (requestId: string, state: "answered" | "cancelled") => void;
    waitForAnswer?: boolean;
  }) {}

  async request(params: Record<string, any>): Promise<Response> {
    const active = this.options.active();
    if (!active || active.threadId !== params.threadId || active.turnId !== params.turnId || this.pending ||
        !Array.isArray(params.questions) || params.questions.length < 1 || params.questions.length > 3) throw new Error("User question has no active owned turn");
    const questions: Question[] = [], ids = new Set<string>();
    for (const raw of params.questions) {
      if (!raw || typeof raw.id !== "string" || !raw.id || raw.id.length > 128 || ids.has(raw.id) ||
          this.options.redact(raw.id) !== raw.id || typeof raw.question !== "string" || !raw.question.trim() || raw.question.length > 8192 || raw.isSecret === true ||
          raw.header != null && (typeof raw.header !== "string" || raw.header.length > 512) ||
          raw.options != null && (!Array.isArray(raw.options) || raw.options.length > 8)) throw new Error("Invalid or secret user question");
      ids.add(raw.id);
      questions.push({ id: raw.id, header: this.options.redact(String(raw.header ?? "")), question: this.options.redact(raw.question),
        ...(typeof raw.isOther === "boolean" ? { isOther: raw.isOther } : {}),
        ...(raw.options ? { options: raw.options.map((option: any) => {
          if (typeof option?.label !== "string" || !option.label.trim() || option.label.length > 1024 || typeof option.description !== "string" || option.description.length > 4096) throw new Error("Invalid question option");
          return { label: this.options.redact(option.label), description: this.options.redact(option.description) };
        }) } : {}) });
    }
    return new Promise<Response>((resolve) => {
      this.accepted = undefined;
      this.pending = { requestId: randomUUID(), questions, turnId: active.turnId, resolve };
      let text = questions.map((question, i) => [questions.length > 1 ? `${i + 1}. ${question.question}` : question.question,
        ...(question.options ?? []).map((option, j) => `${String.fromCharCode(65 + j)}. ${option.label}${option.description ? ` — ${option.description}` : ""}`)].join("\n")).join("\n\n") +
        (questions.length > 1 ? "\n\nReply with one answer per line, numbered 1, 2, 3." : "");
      const choices = questions.length === 1 ? questions[0].options : undefined;
      if (choices?.length && choices.length <= 4 && choices.every(option => !/[|,<>\r\n]/.test(option.label))) {
        text += `\n\n<!-- suggested-replies: ${choices.map((option, i) => `${String.fromCharCode(65 + i)}|${option.label}`).join(", ")} -->`;
      }
      try { this.options.show(text, questions, this.snapshot()!); if (this.options.waitForAnswer === false) this.cancel(); }
      catch { this.cancel(); }
    });
  }

  answer(text: string): boolean {
    const pending = this.pending;
    if (!pending || pending.turnId !== this.options.active()?.turnId) return false;
    const values = pending.questions.length === 1 ? [text.trim()] : pending.questions.map((_, i) => {
      const line = text.split("\n").find(line => new RegExp(`^\\s*${i + 1}[.:：)]\\s*`).test(line));
      return line?.replace(/^\s*\d+[.:：)]\s*/, "").trim() ?? "";
    });
    if (values.some(value => !value || value.length > 32768)) throw new Error("Please answer each numbered question");
    const answers: Record<string, string> = Object.create(null);
    pending.questions.forEach((question, i) => {
      const letter = /^[A-H]$/i.test(values[i]) ? values[i].toUpperCase().charCodeAt(0) - 65 : -1;
      answers[question.id] = question.options?.[letter]?.label ?? values[i];
    });
    this.submit({ requestId: pending.requestId, answers });
    return true;
  }

  snapshot(): NativeUserInputRequest | undefined {
    const pending = this.pending;
    if (!pending || pending.turnId !== this.options.active()?.turnId) return;
    return { engine: "codex", requestId: pending.requestId,
      questions: pending.questions.map(q => ({ ...q, ...(q.options ? { options: q.options.map(o => ({ ...o })) } : {}) })) };
  }

  private validate(value: NativeUserInputAnswer) {
    const skipped = value?.skip === true;
    if (!value || typeof value.requestId !== "string" || !value.answers || typeof value.answers !== "object" || Array.isArray(value.answers) ||
        (skipped ? Object.keys(value.answers).length !== 0 : Object.keys(value.answers).length < 1) || Object.keys(value.answers).length > 3 ||
        Object.entries(value.answers).some(([key, answer]) => !key || key.length > 128 || typeof answer !== "string" || !answer.trim() || answer.length > 32768))
      throw new NativeUserInputError("USER_INPUT_INVALID", "Answer every question with a bounded, nonempty answer");
    const entries = Object.entries(value.answers).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, answer]) => [key, this.options.redact(answer.trim())]);
    const digest = createHash("sha256").update(JSON.stringify({ skipped, entries })).digest("hex");
    const turnId = this.options.active()?.turnId;
    if (this.accepted?.requestId === value.requestId && this.accepted.turnId === turnId) {
      if (this.accepted.digest !== digest) throw new NativeUserInputError("USER_INPUT_INVALID", "This question was already answered differently");
      return { text: this.accepted.text, alreadyAccepted: true as const, digest, pending: undefined, normalized: undefined };
    }
    const pending = this.pending;
    if (!pending || pending.requestId !== value.requestId || pending.turnId !== turnId)
      throw new NativeUserInputError("USER_INPUT_EXPIRED", "This question is no longer waiting for an answer");
    if (!skipped && (Object.keys(value.answers).length !== pending.questions.length || pending.questions.some(q => !Object.hasOwn(value.answers, q.id))))
      throw new NativeUserInputError("USER_INPUT_INVALID", "Answer exactly the current question IDs");
    const normalized = Object.fromEntries(entries);
    const text = skipped ? "Skipped question" : pending.questions.map(q => pending.questions.length === 1 ? normalized[q.id] : `${q.header || q.question}: ${normalized[q.id]}`).join("\n");
    return { text, alreadyAccepted: false as const, digest, pending, normalized };
  }

  prepare(value: NativeUserInputAnswer): NativeUserInputAcceptance {
    const { text, alreadyAccepted } = this.validate(value);
    return { text, alreadyAccepted };
  }

  submit(value: NativeUserInputAnswer): NativeUserInputAcceptance {
    const checked = this.validate(value);
    if (checked.alreadyAccepted) return { text: checked.text, alreadyAccepted: true };
    const { pending, normalized, digest, text } = checked;
    this.pending = undefined;
    this.accepted = { requestId: pending.requestId, digest, turnId: pending.turnId, text };
    try { this.options.resolved?.(pending.requestId, "answered"); } catch { /* Snapshot recovery remains authoritative. */ }
    pending.resolve({ answers: value.skip === true ? {} : Object.fromEntries(pending.questions.map(q => [q.id, { answers: [normalized[q.id]] }])) });
    return { text, alreadyAccepted: false };
  }

  cancel(): void {
    const pending = this.pending;
    this.pending = undefined;
    this.accepted = undefined;
    if (pending) {
      try { this.options.resolved?.(pending.requestId, "cancelled"); } catch { /* Never strand the native request on UI teardown. */ }
      pending.resolve({ answers: {} });
    }
  }
}
