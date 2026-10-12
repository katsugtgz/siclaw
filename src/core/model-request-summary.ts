/** Counts at the SDK and serialized-provider boundaries. Never retain contents or IDs. */
export interface ModelRequestSummary {
  format?: "responses" | "messages" | "unsupported";
  messages: number;
  toolCalls: number;
  toolResults: number;
  matchedToolResults: number;
  toolResultChars: number;
  inlineToolResultImages: number;
  /** Images outside tool-result records; may include SDK attachments or user input. */
  otherMessageImages: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function contentSize(value: unknown): { chars: number; images: number } {
  if (typeof value === "string") return { chars: value.length, images: 0 };
  let chars = 0, images = 0;
  for (const item of Array.isArray(value) ? value : []) {
    const part = record(item);
    if (typeof part.text === "string") chars += part.text.length;
    if (typeof part.type === "string" && ["image", "image_url", "input_image"].includes(part.type)) images++;
  }
  return { chars, images };
}

export function summarizeModelMessages(value: unknown): ModelRequestSummary {
  const messages = Array.isArray(value) ? value : [];
  const summary: ModelRequestSummary = { messages: messages.length, toolCalls: 0,
    toolResults: 0, matchedToolResults: 0, toolResultChars: 0, inlineToolResultImages: 0, otherMessageImages: 0 };
  const calls = new Set<string>();
  const results: Array<{ id: unknown; content: unknown }> = [];
  function call(id: unknown) {
    summary.toolCalls++;
    if (typeof id === "string") calls.add(id);
  }
  for (const raw of messages) {
    const message = record(raw);
    // Chat Completions moves tool images into separate user messages. Count
    // them without attributing arbitrary user images to a particular tool.
    if (message.role !== "toolResult" && message.role !== "tool" && message.type !== "function_call_output") {
      summary.otherMessageImages += contentSize(message.content).images;
    }
    if (message.type === "function_call") call(message.call_id);
    if (message.type === "function_call_output") results.push({ id: message.call_id, content: message.output });
    if (message.role === "toolResult") results.push({ id: message.toolCallId, content: message.content });
    if (message.role === "tool") results.push({ id: message.tool_call_id, content: message.content });
    for (const rawCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) call(record(rawCall).id);
    for (const rawPart of Array.isArray(message.content) ? message.content : []) {
      const part = record(rawPart);
      if (part.type === "toolCall" || part.type === "tool_use") call(part.id);
      if (part.type === "tool_result") results.push({ id: part.tool_use_id, content: part.content });
    }
  }
  for (const result of results) {
    summary.toolResults++;
    if (typeof result.id === "string" && calls.has(result.id)) summary.matchedToolResults++;
    const size = contentSize(result.content);
    summary.toolResultChars += size.chars;
    summary.inlineToolResultImages += size.images;
  }
  return summary;
}

export function summarizeModelPayload(value: unknown): ModelRequestSummary {
  const payload = record(value);
  const format = Array.isArray(payload.input) ? "responses"
    : Array.isArray(payload.messages) ? "messages" : "unsupported";
  return { ...summarizeModelMessages(payload.input ?? payload.messages), format };
}
