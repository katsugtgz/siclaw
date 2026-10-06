type Question = { id: string; header: string; question: string; isSecret?: boolean;
  options?: Array<{ label: string; description: string }> };
type Response = { answers: Record<string, { answers: string[] }> };

/** Answers travel through the existing authenticated chat/steer path. This
 * service never authorizes commands or handles credentials. */
export class CodexUserInput {
  private pending?: { questions: Question[]; turnId: string; resolve: (value: Response) => void };
  constructor(private readonly options: {
    active: () => { threadId: string; turnId: string } | undefined;
    redact: (text: string) => string;
    show: (text: string, questions: Question[]) => void;
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
          raw.options != null && (!Array.isArray(raw.options) || raw.options.length > 8)) throw new Error("Invalid or secret user question");
      ids.add(raw.id);
      questions.push({ id: raw.id, header: this.options.redact(String(raw.header ?? "")), question: this.options.redact(raw.question),
        ...(raw.options ? { options: raw.options.map((option: any) => {
          if (typeof option?.label !== "string" || !option.label.trim() || option.label.length > 1024 || typeof option.description !== "string" || option.description.length > 4096) throw new Error("Invalid question option");
          return { label: this.options.redact(option.label), description: this.options.redact(option.description) };
        }) } : {}) });
    }
    return new Promise<Response>((resolve) => {
      this.pending = { questions, turnId: active.turnId, resolve };
      let text = questions.map((question, i) => [questions.length > 1 ? `${i + 1}. ${question.question}` : question.question,
        ...(question.options ?? []).map((option, j) => `${String.fromCharCode(65 + j)}. ${option.label}${option.description ? ` — ${option.description}` : ""}`)].join("\n")).join("\n\n") +
        (questions.length > 1 ? "\n\nReply with one answer per line, numbered 1, 2, 3." : "");
      const choices = questions.length === 1 ? questions[0].options : undefined;
      if (choices?.length && choices.length <= 4 && choices.every(option => !/[|,<>\r\n]/.test(option.label))) {
        text += `\n\n<!-- suggested-replies: ${choices.map((option, i) => `${String.fromCharCode(65 + i)}|${option.label}`).join(", ")} -->`;
      }
      try { this.options.show(text, questions); if (this.options.waitForAnswer === false) this.cancel(); }
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
    const answers: Response["answers"] = {};
    pending.questions.forEach((question, i) => {
      const letter = /^[A-H]$/i.test(values[i]) ? values[i].toUpperCase().charCodeAt(0) - 65 : -1;
      answers[question.id] = { answers: [this.options.redact(question.options?.[letter]?.label ?? values[i])] };
    });
    this.pending = undefined;
    pending.resolve({ answers });
    return true;
  }

  cancel(): void { const pending = this.pending; this.pending = undefined; pending?.resolve({ answers: {} }); }
}
