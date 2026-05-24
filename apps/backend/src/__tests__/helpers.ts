import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createBackendApp } from "../app.js";

export function makeTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-test-"));
  const backend = createBackendApp({
    env: "test",
    databasePath: path.join(dir, "openoverlay.sqlite"),
    uploadDir: path.join(dir, "uploads"),
    logFile: path.join(dir, "backend.log"),
    jwtSecret: "test-secret",
    corsOrigins: ["http://localhost:5173"]
  });
  return {
    dir,
    app: backend.app,
    agent: request.agent(backend.app),
    request: request(backend.app),
    close() {
      backend.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export async function signup(agent: request.Agent, email: string, password = "password123") {
  const response = await agent.post("/api/auth/signup").send({ email, password }).expect(201);
  return response.body.user as { id: string; email: string };
}
