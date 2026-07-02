import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionToken, SESSION_TTL_SECONDS, verifySessionToken } from "../auth.js";
import { makeTestServer, signup } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => {
  server.close();
});

describe("auth", () => {
  it("keeps session tokens and cookies valid for three months", async () => {
    expect(SESSION_TTL_SECONDS).toBe(90 * 24 * 60 * 60);

    const now = 1_700_000_000;
    const token = createSessionToken("user-1", "test-secret", now);
    expect(verifySessionToken(token, "test-secret", now + SESSION_TTL_SECONDS - 1)?.sub).toBe("user-1");
    expect(verifySessionToken(token, "test-secret", now + SESSION_TTL_SECONDS + 1)).toBeNull();

    const response = await server.request.post("/api/auth/signup").send({ email: "cookie@example.com", password: "password123" }).expect(201);
    const setCookie = response.headers["set-cookie"];
    expect(Array.isArray(setCookie) ? setCookie.join(";") : setCookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  it("signs up, returns the current user, logs out, and logs back in", async () => {
    const user = await signup(server.agent, "user@example.com");
    expect(user.email).toBe("user@example.com");

    const me = await server.agent.get("/api/auth/me").expect(200);
    expect(me.body.user.email).toBe("user@example.com");

    await server.agent.post("/api/auth/logout").send({}).expect(200);
    await server.agent.get("/api/auth/me").expect(401);

    await server.agent.post("/api/auth/login").send({ email: "user@example.com", password: "password123" }).expect(200);
    await server.agent.get("/api/auth/me").expect(200);
  });

  it("rate-limits repeated failed login attempts", async () => {
    await signup(server.agent, "limit@example.com");
    for (let i = 0; i < 5; i += 1) {
      await server.request.post("/api/auth/login").send({ email: "limit@example.com", password: "wrong-password" }).expect(401);
    }
    await server.request.post("/api/auth/login").send({ email: "limit@example.com", password: "wrong-password" }).expect(429);
  });

  it("rejects cookie-authenticated state changes from disallowed origins", async () => {
    await signup(server.agent, "origin-check@example.com");

    await server.agent
      .post("/api/teams")
      .set("Origin", "https://evil.example")
      .send({ fullName: "Evil FC", shortName: "Evil" })
      .expect(403);

    await server.agent
      .post("/api/teams")
      .set("Origin", "http://localhost:5173")
      .send({ fullName: "Local FC", shortName: "Local" })
      .expect(201);
  });
});
