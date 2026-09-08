import { createServer } from "node:http";
import { Server } from "socket.io";
import { describe, expect, it, vi } from "vitest";
import { closeBackendServer } from "../lifecycle.js";
import type { RealtimeHub } from "../realtime.js";

describe("backend shutdown completion", () => {
  it("waits for realtime adapter cleanup before reporting shutdown complete", async () => {
    const server = createServer();
    const io = new Server(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(io.of("/").adapter, "close").mockReturnValue(cleanup);
    let completed = false;
    const closing = closeBackendServer(server, { io } as RealtimeHub).then(() => {
      completed = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(completed).toBe(false);
      release();
      await closing;
      expect(server.listening).toBe(false);
    } finally {
      release();
      await closing;
      await io.close();
      vi.restoreAllMocks();
    }
  });
});
