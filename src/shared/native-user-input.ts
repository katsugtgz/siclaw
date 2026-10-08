/** UI questions are data, never execution approval or credential requests. */
export interface NativeUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  options?: Array<{ label: string; description: string }>;
}

export interface NativeUserInputRequest {
  engine: "codex";
  requestId: string;
  questions: NativeUserInputQuestion[];
}

export interface NativeUserInputAnswer {
  requestId: string;
  answers: Record<string, string>;
  skip?: boolean;
}

export interface NativeUserInputAcceptance {
  text: string;
  alreadyAccepted: boolean;
}

export class NativeUserInputError extends Error {
  constructor(readonly code: "USER_INPUT_EXPIRED" | "USER_INPUT_INVALID" | "USER_INPUT_UNAVAILABLE", message: string) {
    super(`${code}: ${message}`);
  }
}
