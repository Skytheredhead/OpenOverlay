import http from "node:http";
import { createBackendApp } from "./app.js";
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

const shutdown = (signal: string) => {
  backend.ctx.logger.info("openoverlay_backend_shutdown", { signal });
  server.close(() => {
    backend.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
