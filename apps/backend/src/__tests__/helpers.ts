import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createBackendApp } from "../app.js";
import type { AppConfig } from "../config.js";

export function makeTestServer(overrides: Partial<AppConfig> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-test-"));
  const backend = createBackendApp({
    env: "test",
    databasePath: path.join(dir, "openoverlay.sqlite"),
    uploadDir: path.join(dir, "uploads"),
    logFile: path.join(dir, "backend.log"),
    jwtSecret: "test-secret",
    corsOrigins: ["http://localhost:5173"],
    storageMinimumFreeBytes: 0,
    ...overrides
  });
  return {
    dir,
    backend,
    app: backend.app,
    agent: request.agent(backend.app),
    request: request(backend.app),
    close() {
      backend.close();
      // File logging uses asynchronous appendFile calls. On slower CI filesystems,
      // one can still be completing immediately after the backend is closed.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  };
}

export async function signup(agent: request.Agent, email: string, password = "password123") {
  const response = await agent.post("/api/auth/signup").send({ email, password }).expect(201);
  return response.body.user as { id: string; email: string };
}
