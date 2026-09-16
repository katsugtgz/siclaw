/** A whole prompt execution, not one provider sampling or SDK agent run. */
export type ExecutionOutcome = "completed" | "error" | "aborted";

export interface ExecutionEndEvent {
  type: "execution_end";
  sessionId: string;
  turnId?: string;
  outcome: ExecutionOutcome | "unknown";
}
