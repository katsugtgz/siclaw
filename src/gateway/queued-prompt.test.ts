import { it, expect, vi } from "vitest";
import { dispatchQueuedPrompt } from "./queued-prompt.js";
it("waits for a refused busy turn without steering or duplicating accepted prompts", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("Session is already running"), { status: 409 }),
    )
    .mockRejectedValueOnce(
      Object.assign(
        new Error("Session execution authorization is still in use"),
        { status: 409 },
      ),
    )
    .mockResolvedValue({ ok: true });
  await expect(
    dispatchQueuedPrompt(send, new AbortController().signal, 1),
  ).resolves.toEqual({ ok: true });
  expect(send).toHaveBeenCalledTimes(3);
});
it.each([undefined, 500, 504, 403])(
  "does not retry an ambiguous/unauthorized result (%s)",
  async (status) => {
    const send = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Session is already running"), { status }),
      );
    await expect(
      dispatchQueuedPrompt(send, new AbortController().signal, 1),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  },
);
it("does not silently downgrade an engine change to steer", async () => {
  const send = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("Queued input requires Codex"), { status: 409 }),
    );
  await expect(
    dispatchQueuedPrompt(send, new AbortController().signal, 1),
  ).rejects.toThrow("Codex");
  expect(send).toHaveBeenCalledOnce();
});
it("Stop cancels the wait without another dispatch", async () => {
  const ctl = new AbortController();
  const send = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("Session is already running"), { status: 409 }),
    );
  const work = dispatchQueuedPrompt(send, ctl.signal, 10000);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  ctl.abort();
  await expect(work).rejects.toThrow();
  expect(send).toHaveBeenCalledOnce();
});
