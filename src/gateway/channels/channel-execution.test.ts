import { describe, expect, it, vi } from "vitest";
import { channelExecutionEvents, ChannelExecutionError } from "./channel-execution.js";

const answer = (text: string, stopReason = "stop") => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason } });
async function* stream(events: unknown[]) { yield* events; }
async function drain(events: AsyncIterable<unknown>, conversation = false) {
  const result = []; for await (const event of channelExecutionEvents(events, conversation)) result.push(event); return result;
}

describe("channel execution boundary, independent of provider and transport", () => {
  it("sampling/agent end and child completion do not finish a channel run", async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const finished = vi.fn();
    const source = (async function* () {
      yield answer("working", "toolUse"); yield { type: "agent_end" };
      yield { type: "subagent_done", status: "done" };
      await hold;
      yield answer("final report"); yield { type: "execution_end", outcome: "completed" };
    })();
    const pending = drain(source).then(result => { finished(); return result; });
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).not.toHaveBeenCalled();
    release();
    expect((await pending).at(-1)).toEqual(answer("final report"));
  });
  it("EOF is a delivery failure even after assistant text or agent_end", async () => {
    await expect(drain(stream([answer("partial progress"), { type: "agent_end" }]))).rejects.toMatchObject({ outcome: "disconnected" });
  });
  it("transport failure remains a delivery error, not a successful partial answer", async () => {
    const source = (async function* () { yield answer("partial"); throw new Error("socket closed"); })();
    await expect(drain(source)).rejects.toMatchObject({ outcome: "disconnected", cause: { message: "socket closed" } });
  });
  it.each(["error", "aborted", "unknown"])("never delivers success for execution outcome %s", async outcome => {
    await expect(drain(stream([answer("previous progress"), { type: "execution_end", outcome }]))).rejects.toBeInstanceOf(ChannelExecutionError);
  });
  it("a provider error can recover without ending the logical request", async () => {
    const events = [answer("", "error"), { type: "agent_end" }, { type: "model_route_rollback" }, answer("recovered"),
      { type: "execution_end", outcome: "completed" }];
    expect((await drain(stream(events))).at(-1)).toEqual(answer("recovered"));
  });
  it("empty stop is not recovery from a model error", async () => {
    await expect(drain(stream([answer("", "error"), answer(""), { type: "execution_end", outcome: "completed" }]))).rejects.toMatchObject({ outcome: "error" });
  });
  it("a conversation waits for its own terminal event, not a destination box's end", async () => {
    const events = [answer("source progress"), { type: "execution_end", outcome: "completed" },
      { type: "agent_switch" }, answer("destination answer"), { type: "prompt_done" }];
    expect((await drain(stream(events), true)).at(-1)).toEqual(answer("destination answer"));
  });
  it("does not consume trailing events after a confirmed completion", async () => {
    expect(await drain(stream([{ type: "execution_end", outcome: "completed" }, answer("unrelated")]))).toEqual([]);
  });
});
