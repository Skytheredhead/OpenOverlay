import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createBackendApp } from "../app.js";

describe("persistence", () => {
  it("keeps overlay state after backend restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-persist-"));
    const config = {
      env: "test" as const,
      databasePath: path.join(dir, "db.sqlite"),
      uploadDir: path.join(dir, "uploads"),
      logFile: path.join(dir, "backend.log"),
      jwtSecret: "test-secret",
      corsOrigins: ["http://localhost:5173"]
    };

    const first = createBackendApp(config);
    const agent = request.agent(first.app);
    await agent.post("/api/auth/signup").send({ email: "persist@example.com", password: "password123" }).expect(201);
    const created = await agent.post("/api/presets").send({ name: "Persistent Match", type: "soccer" }).expect(201);
    await agent.post(`/api/presets/${created.body.preset.id}/actions/home-score-plus`).send({}).expect(200);
    first.close();

    const second = createBackendApp(config);
    try {
      const overlay = await request(second.app).get(`/api/overlay/${created.body.preset.publicId}`).expect(200);
      expect(overlay.body.overlay.state.score.home).toBe(1);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
