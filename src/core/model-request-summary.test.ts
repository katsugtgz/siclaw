import { describe, expect, it } from "vitest";
import { summarizeModelMessages, summarizeModelPayload } from "./model-request-summary.js";

describe("model request diagnostics", () => {
  it("distinguishes missing results and unmatched call IDs without exposing content", () => {
    const call = { type: "function_call", call_id: "opaque", arguments: "SECRET", name: "Read" };
    expect(summarizeModelPayload({ input: [call] }).toolResults).toBe(0);
    const summary = summarizeModelPayload({ authorization: "SECRET", input: [call,
      { type: "function_call_output", call_id: "different", output: "SECRET" }] });
    expect(summary).toMatchObject({ toolCalls: 1, toolResults: 1, matchedToolResults: 0, toolResultChars: 6 });
    expect(JSON.stringify(summary)).not.toMatch(/SECRET|opaque|different|Read/);
  });
  it("counts Pi context and provider-specific result forms consistently", () => {
    const pi = summarizeModelMessages([{ role: "assistant", content: [{ type: "toolCall", id: "c" }] },
      { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "fact" }, { type: "image", data: "SECRET" }] }]);
    expect(pi).toMatchObject({ toolCalls: 1, toolResults: 1, matchedToolResults: 1, toolResultChars: 4, inlineToolResultImages: 1 });
    const chat = summarizeModelPayload({ messages: [{ role: "assistant", tool_calls: [{ id: "c" }] },
      { role: "tool", tool_call_id: "c", content: "fact" }] });
    expect(chat).toMatchObject({ toolCalls: 1, matchedToolResults: 1, toolResultChars: 4 });
    const anthropic = summarizeModelPayload({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "fact" }] }] });
    expect(anthropic).toEqual(chat);
  });
});
