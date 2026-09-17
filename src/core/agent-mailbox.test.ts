import { describe, expect, it } from "vitest";
import { AgentMailbox } from "./agent-mailbox.js";

describe("active-turn agent mailbox", () => {
  it("replays consumed mail on model-route rollback without dropping later arrivals", () => {
    const mailbox = new AgentMailbox();
    mailbox.post("one"); const checkpoint = mailbox.checkpoint();
    expect(mailbox.take()).toBe("one");
    mailbox.post("two"); mailbox.defer();
    mailbox.rollback(checkpoint);
    expect(mailbox.take()).toBe("one\n\ntwo");
  });
  it("wakes for mail, drains a batch once, and never consumes on wait", async () => {
    const mailbox = new AgentMailbox();
    const wait = mailbox.wait(1000);
    mailbox.post("first"); mailbox.post("second");
    expect(await wait).toBe("mail");
    expect(await mailbox.wait(1000)).toBe("mail");
    expect(mailbox.take()).toBe("first\n\nsecond");
    expect(mailbox.take()).toBeUndefined();
  });
  it("defers mail after final and reopens on a tool/user continuation", () => {
    const mailbox = new AgentMailbox();
    mailbox.defer(); mailbox.post("result");
    expect(mailbox.ready).toBe(false);
    expect(mailbox.take()).toBeUndefined();
    mailbox.reopen(); expect(mailbox.take()).toBe("result");
  });
  it("does not revive a closed turn or carry its mail into a successor", async () => {
    const old = new AgentMailbox();
    const wait = old.wait(1000);
    old.close(); old.reopen();
    expect(await wait).toBe("closed");
    expect(old.post("late")).toBe(false);
    expect(new AgentMailbox().take()).toBeUndefined();
  });
  it("timeout, steering and cancellation end only the wait", async () => {
    const mailbox = new AgentMailbox();
    expect(await mailbox.wait(1)).toBe("timeout");
    const steering = mailbox.wait(1000); mailbox.steer();
    expect(await steering).toBe("steered");
    const controller = new AbortController();
    const waiting = mailbox.wait(1000, controller.signal); controller.abort();
    expect(await waiting).toBe("aborted");
    expect(mailbox.post("still running child later finishes")).toBe(true);
  });
});
