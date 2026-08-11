import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebouncedSerialMutationQueue, KeyedDebouncer, KeyedSerialTaskQueue } from "./mutationQueue";

describe("DebouncedSerialMutationQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a delayed save bound to its original resource", async () => {
    const queue = new DebouncedSerialMutationQueue(180);
    const calls: string[] = [];

    queue.schedule("preset-a", async () => { calls.push("save-a"); });
    queue.schedule("preset-b", async () => { calls.push("save-b"); });

    await vi.advanceTimersByTimeAsync(180);
    await queue.flush();

    expect(calls).toEqual(["save-a", "save-b"]);
  });

  it("flushes autosave before an action and serializes rapid actions", async () => {
    const queue = new DebouncedSerialMutationQueue(180);
    const calls: string[] = [];
    let releaseSave: (() => void) | undefined;

    queue.schedule("preset-a", () => new Promise<void>((resolve) => {
      calls.push("save");
      releaseSave = resolve;
    }));
    const firstAction = queue.run(async () => { calls.push("action-1"); });
    const secondAction = queue.run(async () => { calls.push("action-2"); });

    await Promise.resolve();
    expect(calls).toEqual(["save"]);
    releaseSave?.();
    await Promise.all([firstAction, secondAction]);

    expect(calls).toEqual(["save", "action-1", "action-2"]);
  });

  it("coalesces state snapshots for the same resource", async () => {
    const queue = new DebouncedSerialMutationQueue(180);
    const calls: string[] = [];

    queue.schedule("preset-a", async () => { calls.push("old"); });
    queue.schedule("preset-a", async () => { calls.push("latest"); });
    await vi.advanceTimersByTimeAsync(180);
    await queue.flush();

    expect(calls).toEqual(["latest"]);
  });

  it("does not run an action when the required autosave fails, then permits a retry", async () => {
    const queue = new DebouncedSerialMutationQueue(180);
    const action = vi.fn(async () => undefined);

    queue.schedule("preset-a", async () => { throw new Error("save failed"); });
    await expect(queue.run(action)).rejects.toThrow("save failed");
    expect(action).not.toHaveBeenCalled();

    await expect(queue.run(action)).resolves.toBeUndefined();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does not let a superseded failed save poison a later successful save and action", async () => {
    const queue = new DebouncedSerialMutationQueue(180);
    const calls: string[] = [];

    queue.schedule("preset-a", async () => {
      calls.push("failed-save");
      throw new Error("offline");
    });
    await vi.advanceTimersByTimeAsync(180);
    await expect(queue.flush()).rejects.toThrow("offline");

    queue.schedule("preset-a", async () => { calls.push("retry-save"); });
    const action = queue.run(async () => { calls.push("action"); });
    await expect(action).resolves.toBeUndefined();
    expect(calls).toEqual(["failed-save", "retry-save", "action"]);
  });
});

describe("KeyedDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not cancel another record's pending save", async () => {
    const debouncer = new KeyedDebouncer(500);
    const calls: string[] = [];

    debouncer.schedule("team-a", () => calls.push("team-a"));
    debouncer.schedule("team-b", () => calls.push("team-b"));
    await vi.advanceTimersByTimeAsync(500);

    expect(calls).toEqual(["team-a", "team-b"]);
  });
});

describe("KeyedSerialTaskQueue", () => {
  it("prevents an older slow save from arriving after a newer save for the same record", async () => {
    const queue = new KeyedSerialTaskQueue();
    const calls: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = queue.run("team-a", () => new Promise<void>((resolve) => {
      calls.push("first-start");
      releaseFirst = () => {
        calls.push("first-end");
        resolve();
      };
    }));
    const second = queue.run("team-a", async () => { calls.push("second"); });

    await Promise.resolve();
    expect(calls).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual(["first-start", "first-end", "second"]);
  });

  it("continues after a failed save and does not block a different record", async () => {
    const queue = new KeyedSerialTaskQueue();
    const calls: string[] = [];
    const failed = queue.run("team-a", async () => { throw new Error("offline"); });
    const retry = queue.run("team-a", async () => { calls.push("retry"); });
    const other = queue.run("team-b", async () => { calls.push("other"); });

    await expect(failed).rejects.toThrow("offline");
    await Promise.all([retry, other]);
    expect(calls).toContain("retry");
    expect(calls).toContain("other");
  });
});
