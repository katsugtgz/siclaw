import { messageProducedOutput } from "../sse-consumer.js";

export class ChannelExecutionError extends Error {
  constructor(readonly outcome: "error" | "aborted" | "disconnected", cause?: unknown) {
    super(outcome === "aborted" ? "Agent execution was cancelled" : outcome === "disconnected"
      ? "Agent event stream ended before execution completion; result delivery is incomplete"
      : "Agent execution failed; inspect its trace for details", { cause });
    this.name = "ChannelExecutionError";
  }
}

/** Transport-independent execution boundary for IM renderers.
 * No provider AbortController or Feishu WSClient belongs in this layer. */
export async function* channelExecutionEvents(
  source: AsyncIterable<unknown>,
  conversationEvents = false,
): AsyncIterable<Record<string, any>> {
  let failure: "error" | "aborted" | undefined;
  try {
    for await (const raw of source) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as Record<string, any>;
      if (event.type === "agent_switch" ||
          (event.type === "message_start" && event.message?.role === "user")) failure = undefined;
      if (event.type === "stream_error" || event.type === "model_route_exhausted") failure = "error";
      if (event.type === "message_end" && event.message?.role === "assistant") {
        if (event.message.stopReason === "error") failure = "error";
        else if (event.message.stopReason === "aborted") failure = "aborted";
        else if (messageProducedOutput(event.message)) failure = undefined;
      }
      // AgentBox's execution_end is a prompt-level signal. The control plane has
      // its own prompt_done/done after cross-runtime handoff and persistence.
      const terminal = conversationEvents
        ? event.type === "prompt_done" || event.type === "done"
        : event.type === "execution_end";
      if (terminal) {
        if (event.aborted === true || event.outcome === "aborted") throw new ChannelExecutionError("aborted");
        if (event.outcome === "error" || failure) throw new ChannelExecutionError(failure ?? "error");
        if (!conversationEvents && event.outcome !== "completed") throw new ChannelExecutionError("disconnected");
        return;
      }
      // message_end / turn_end / agent_end are progress, never IM finalization.
      yield event;
    }
  } catch (error) {
    if (error instanceof ChannelExecutionError) throw error;
    throw new ChannelExecutionError("disconnected", error);
  }
  throw new ChannelExecutionError("disconnected");
}
