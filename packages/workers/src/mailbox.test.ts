import { describe, expect, it } from "vitest";
import { SessionMailbox } from "./mailbox.js";
import { waitUntil } from "./fakes.test-util.js";

describe("SessionMailbox", () => {
  it("queues FIFO and drains with poll", () => {
    const mailbox = new SessionMailbox();
    mailbox.send("s1", "one", "W1");
    mailbox.send("s1", "two", "W2");
    mailbox.send("s2", "other", "W3");
    expect(mailbox.pending("s1")).toBe(2);
    expect(mailbox.pendingTotal()).toBe(3);
    expect(mailbox.poll("s1").map((m) => m.content)).toEqual(["one", "two"]);
    expect(mailbox.pending("s1")).toBe(0);
    expect(mailbox.pending("s2")).toBe(1);
  });

  it("wakes a parked consumer and delivers straight to it", async () => {
    const mailbox = new SessionMailbox();
    const parked = mailbox.recv("s1");
    let delivered = false;
    void parked.then(() => {
      delivered = true;
    });
    await waitUntil(() => mailbox.pending("s1") === 0);
    expect(delivered).toBe(false);
    mailbox.send("s1", "wake up", "W1");
    const msg = await parked;
    expect(msg?.content).toBe("wake up");
    expect(msg?.from_label).toBe("W1");
    expect(mailbox.pending("s1")).toBe(0);
  });

  it("delivers immediately when the queue is not empty", async () => {
    const mailbox = new SessionMailbox();
    mailbox.send("s1", "already here", "W1");
    await expect(mailbox.recv("s1")).resolves.toMatchObject({ content: "already here" });
  });

  it("wakes in FIFO order for multiple parked consumers", async () => {
    const mailbox = new SessionMailbox();
    const first = mailbox.recv("s1");
    const second = mailbox.recv("s1");
    mailbox.send("s1", "a", "W1");
    mailbox.send("s1", "b", "W2");
    expect((await first)?.content).toBe("a");
    expect((await second)?.content).toBe("b");
  });

  it("releases a park when the caller's signal aborts", async () => {
    const mailbox = new SessionMailbox();
    const controller = new AbortController();
    const parked = mailbox.recv("s1", controller.signal);
    controller.abort();
    await expect(parked).resolves.toBeNull();
  });

  it("returns null for an already aborted signal without parking", async () => {
    const mailbox = new SessionMailbox();
    const controller = new AbortController();
    controller.abort();
    await expect(mailbox.recv("s1", controller.signal)).resolves.toBeNull();
  });

  it("purges per session and globally", () => {
    const mailbox = new SessionMailbox();
    mailbox.send("s1", "x", "W1");
    mailbox.send("s2", "y", "W1");
    expect(mailbox.purge("s1")).toBe(1);
    expect(mailbox.pendingTotal()).toBe(1);
    expect(mailbox.purgeAll()).toBe(1);
    expect(mailbox.pendingTotal()).toBe(0);
  });

  it("release wakes every parked consumer and refuses further delivery", async () => {
    const mailbox = new SessionMailbox();
    const parked = mailbox.recv("s1");
    mailbox.release();
    await expect(parked).resolves.toBeNull();
    expect(mailbox.isReleased).toBe(true);
    mailbox.send("s1", "after release", "W1");
    expect(mailbox.pending("s1")).toBe(0);
    await expect(mailbox.recv("s1")).resolves.toBeNull();
  });

  it("stamps every message with an id and a timestamp from the injected clock", () => {
    const mailbox = new SessionMailbox(() => 1_700_000);
    const first = mailbox.send("s1", "x", "W1");
    const second = mailbox.send("s1", "y", "W1");
    expect([first.id, second.id]).toEqual([1, 2]);
    expect(first.at).toBe(1_700_000);
  });
});
