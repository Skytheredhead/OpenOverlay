import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimeRetry } from "./realtimeRetry";

afterEach(() => vi.useRealTimers());

describe("RealtimeRetry", () => {
  it("leaves transport reconnects to Socket.IO and bounds repeated server rejections", () => {
    vi.useFakeTimers();
    const connect = vi.fn();
    const retry = new RealtimeRetry(connect);
    retry.disconnected("transport close");
    vi.advanceTimersByTime(60_000);
    expect(connect).not.toHaveBeenCalled();
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      connect.mockClear();
      retry.disconnected("io server disconnect");
      retry.disconnected("io server disconnect");
      vi.advanceTimersByTime(delay - 1);
      expect(connect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(connect).toHaveBeenCalledOnce();
    }
    retry.receivedState();
    connect.mockClear();
    retry.disconnected("io server disconnect");
    vi.advanceTimersByTime(1000);
    expect(connect).toHaveBeenCalledOnce();
    retry.stop();
  });
});
