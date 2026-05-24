import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, signup } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => {
  server.close();
});

describe("auth", () => {
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
});
