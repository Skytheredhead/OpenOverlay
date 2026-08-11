import type { Server as HttpServer } from "node:http";
import type { RealtimeHub } from "./realtime.js";

/**
 * Stop upgraded realtime connections before waiting for the HTTP server.
 * Node's Server.close() does not terminate upgraded WebSocket connections, so
 * waiting on it first can deadlock graceful shutdown while overlays are open.
 */
export async function closeBackendServer(server: HttpServer, realtime?: RealtimeHub): Promise<void> {
  realtime?.io.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
