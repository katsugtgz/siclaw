import { describe, expect, it, vi } from "vitest";
import { createNativeUserInputHandlers } from "./native-user-input.js";

describe("native user input RPC", () => {
  it("validates concurrent retries but persists one human reply", async () => {
    const client = { getUserInput: vi.fn(), submitUserInput: vi.fn().mockResolvedValue({ text: "Detailed", alreadyAccepted: false }) };
    const persist = vi.fn().mockResolvedValue("message-id");
    const rpc = createNativeUserInputHandlers({ client: async () => client, persist });
    const params = { sessionId: "s", answer: { requestId: "q", answers: { format: "Detailed" } } };
    const results = await Promise.all([rpc.answer(params), rpc.answer(params)]);
    expect(client.submitUserInput).toHaveBeenCalledTimes(4);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
    client.submitUserInput.mockRejectedValue(new Error("USER_INPUT_EXPIRED"));
    await expect(rpc.answer(params)).rejects.toThrow("USER_INPUT_EXPIRED");
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it("does not create a box, persist or dispatch a prompt for an expired question", async () => {
    const persist = vi.fn(), rpc = createNativeUserInputHandlers({ client: async () => undefined, persist });
    expect(await rpc.state({ sessionId: "s" })).toEqual({ nativeUserInput: null });
    await expect(rpc.answer({ sessionId: "s", answer: {} })).rejects.toThrow("USER_INPUT_EXPIRED");
    expect(persist).not.toHaveBeenCalled();
  });
});
