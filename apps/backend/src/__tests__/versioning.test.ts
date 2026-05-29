import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestServer } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => {
  server.close();
});

describe("API versioning", () => {
  it("serves v1 routes and keeps unversioned API routes as v1 aliases", async () => {
    await server.agent.post("/api/v1/auth/signup").send({ email: "versioned@example.com", password: "password123" }).expect(201);

    const versioned = await server.agent.get("/api/v1/auth/me").expect(200);
    expect(versioned.body.user.email).toBe("versioned@example.com");

    const aliased = await server.agent.get("/api/auth/me").expect(200);
    expect(aliased.body.user.email).toBe("versioned@example.com");
  });

  it("rejects explicitly unsupported API versions", async () => {
    await server.request.get("/api/v1/auth/me").set("X-OpenOverlay-Api-Version", "v999").expect(426);
  });
});
