import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assistantTextBlocks, textPhase } from "../shared/assistant-items.js";
import type { AgentMailbox } from "./agent-mailbox.js";

type Agent = AgentSession["agent"];
const bindings = new WeakMap<Agent, { mailbox: AgentMailbox; deliver: () => boolean }>();
const wrappedAgents = new WeakSet<Agent>();

/** Below the recorder/guards so a cut-off sampling still has a terminal event,
 * timing and usage evidence. The session loop itself remains the installed SDK. */
export function installMailboxStream(agent: Agent): void {
  if (wrappedAgents.has(agent)) return;
  wrappedAgents.add(agent);
  const base = agent.streamFunction;
  agent.streamFunction = (model, context, options) => {
    const binding = bindings.get(agent);
    // Compaction/auxiliary calls share the stream function but must never drain
    // the active agent's inbox into their separate summarization conversation.
    return binding && Array.isArray(context.tools)
      ? wrapMailboxStream(base, binding.mailbox, binding.deliver, () => agent.hasQueuedMessages())(model, context, options)
      : base(model, context, options);
  };
}

/** Interrupt only this provider sampling at a completed, replayable item boundary.
 * The pi run/turn is NOT aborted: queued mail drives its next model request. */
export function wrapMailboxStream(base: StreamFn, mailbox: AgentMailbox, deliver: () => boolean, hasQueuedInput = () => false): StreamFn {
  return async (model, context, options) => {
    const sampling = new AbortController();
    const abort = () => sampling.abort(options?.signal?.reason);
    options?.signal?.addEventListener("abort", abort, { once: true });
    if (options?.signal?.aborted) abort();
    let source;
    try {
      source = await base(model, context, { ...options, signal: sampling.signal });
    } catch (error) {
      options?.signal?.removeEventListener("abort", abort);
      throw error;
    }
    let cutoff: AssistantMessage | undefined;
    // Delegate all normal stream behavior, including provider errors and usage.
    const wrapped = Object.create(source) as typeof source;
    wrapped.result = () => cutoff ? Promise.resolve(cutoff) : source.result();
    wrapped[Symbol.asyncIterator] = async function* () {
      try {
        for await (const event of source) {
          if (event.type === "toolcall_start") mailbox.reopen();
          const textBlock = event.type === "text_end" ? event.partial.content[event.contentIndex] : undefined;
          const phase = textBlock?.type === "text" ? textPhase(textBlock.textSignature) : undefined;
          if (event.type === "text_end" && event.content.trim() && phase !== "commentary" && !hasQueuedInput()) mailbox.defer();
          const safeBoundary = event.type === "thinking_end" ||
            (event.type === "text_end" && phase === "commentary");
          // Providers may reuse/mutate partial objects while their events are queued.
          // Freeze only the completed prefix, never a later unobserved answer block.
          const boundary = safeBoundary && "partial" in event && "contentIndex" in event &&
            !event.partial.content.some(block => block.type === "toolCall")
            ? structuredClone(event.partial) : undefined;
          if (boundary && (event.type === "text_end" || event.type === "thinking_end")) {
            boundary.content = boundary.content.slice(0, event.contentIndex + 1);
            const block = boundary.content[event.contentIndex];
            if (block?.type === "text") block.text = event.content;
            if (block?.type === "thinking") block.thinking = event.content;
          }
          yield event;
          if (boundary && mailbox.ready && !options?.signal?.aborted && deliver()) {
            cutoff = { ...boundary, stopReason: "stop" };
            console.debug("[agent-mailbox] sampling yielded at", event.type);
            sampling.abort();
            yield { type: "done", reason: "stop", message: cutoff };
            return;
          }
        }
      } finally {
        options?.signal?.removeEventListener("abort", abort);
      }
    };
    return wrapped;
  };
}

/** Bound for one prompt attempt. No SDK fork and no independent parent prompt. */
export function installMailboxLoop(session: AgentSession, mailbox: AgentMailbox): () => void {
  const agent = session.agent;
  installMailboxStream(agent);
  const deliver = () => {
    if (agent.signal?.aborted) return false;
    const text = mailbox.take();
    if (!text) return false;
    // A runtime-authored evidence message, not user intent and not a new prompt.
    agent.steer({ role: "custom", customType: "agent_mailbox", content: text, display: false, timestamp: Date.now() });
    return true;
  };
  bindings.set(agent, { mailbox, deliver });
  // Includes results re-queued by a model-route rollback before its next attempt.
  deliver();
  const unsubscribe = agent.subscribe(event => {
    if (event.type === "tool_execution_start") mailbox.reopen();
    if (event.type !== "turn_end") return;
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason === "error" || message.stopReason === "aborted") return;
    if (message.content.some(block => block.type === "toolCall")) mailbox.reopen();
    else if (!agent.hasQueuedMessages() && assistantTextBlocks({ content: message.content }).some(block => block.text.trim() && block.phase !== "commentary")) mailbox.defer();
    deliver();
  });
  return () => {
    unsubscribe();
    bindings.delete(agent);
  };
}
