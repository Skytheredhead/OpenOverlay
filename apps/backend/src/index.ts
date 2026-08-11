import http from "node:http";
import { createBackendApp } from "./app.js";
import { closeBackendServer } from "./lifecycle.js";
import { attachRealtime } from "./realtime.js";

const backend = createBackendApp();
const server = http.createServer(backend.app);
backend.ctx.realtime = attachRealtime(server, backend.ctx);

server.listen(backend.ctx.config.port, backend.ctx.config.host, () => {
  backend.ctx.logger.info("openoverlay_backend_started", {
    host: backend.ctx.config.host,
    port: backend.ctx.config.port,
    env: backend.ctx.config.env
  });
});

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  backend.ctx.logger.info("openoverlay_backend_shutdown", { signal });
  const forceExitTimer = setTimeout(() => process.exit(1), 10_000);
  forceExitTimer.unref();
  void (async () => {
    try {
      await closeBackendServer(server, backend.ctx.realtime);
      backend.close();
      await backend.ctx.logger.flush?.();
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  })();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
