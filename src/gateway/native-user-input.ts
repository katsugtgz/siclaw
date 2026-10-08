import type { NativeUserInputAnswer, NativeUserInputRequest, NativeUserInputAcceptance } from "../shared/native-user-input.js";

interface InputClient {
  getUserInput(sessionId: string): Promise<{ nativeUserInput: NativeUserInputRequest | null }>;
  submitUserInput(sessionId: string, answer: NativeUserInputAnswer, prepare?: boolean): Promise<NativeUserInputAcceptance & { traceId?: string }>;
}

/** Only talks to an existing, owner-scoped box. Never starts a replacement turn. */
export function createNativeUserInputHandlers(options: {
  client: (params: Record<string, unknown>) => Promise<InputClient | undefined>;
  persist: (sessionId: string, requestId: string, text: string, traceId?: string) => Promise<string>;
}) {
  const saved = new Map<string, { promise: Promise<string>; settled: boolean }>();
  return {
    state: async (params: Record<string, unknown>) => {
      const client = await options.client(params);
      return client ? client.getUserInput(params.sessionId as string) : { nativeUserInput: null };
    },
    answer: async (params: Record<string, unknown>) => {
      const client = await options.client(params);
      if (!client) throw new Error("USER_INPUT_EXPIRED: No existing executor is waiting for this answer");
      const answer = params.answer as NativeUserInputAnswer;
      if (!answer || typeof answer.requestId !== "string") throw new Error("USER_INPUT_INVALID: Missing question request ID");
      const sessionId = params.sessionId as string;
      // The box validates even retries: a cached HTTP result must not revive an
      // expired question, accept changed answers, or answer a successor question.
      const accepted = await client.submitUserInput(sessionId, answer, true);
      const key = `${sessionId}:${answer.requestId}`;
      let row = saved.get(key);
      if (!row) {
        for (const [oldKey, old] of saved) {
          if (saved.size < 1024) break;
          if (old.settled) saved.delete(oldKey);
        }
        row = { settled: false, promise: Promise.resolve("") };
        const entry = row;
        row.promise = options.persist(sessionId, answer.requestId, accepted.text, accepted.traceId)
          .then(id => { entry.settled = true; return id; }, error => { saved.delete(key); throw error; });
        saved.set(key, row);
      }
      const messageId = await row.promise;
      // Revalidate the exact ID after persistence. Stop/successor questions can
      // race the write, but an old reply must never resume the successor.
      await client.submitUserInput(sessionId, answer);
      return { ok: true, messageId, text: accepted.text };
    },
  };
}
