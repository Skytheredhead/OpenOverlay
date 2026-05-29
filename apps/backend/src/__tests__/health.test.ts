import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestServer } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => {
  server.close();
});

describe("health", () => {
  it("returns backend build metadata for deployment sync checks", async () => {
    const response = await server.request.get("/health").expect(200);

    expect(response.body).toMatchObject({
      ok: true,
      app: "OpenOverlay",
      component: "backend",
      build: {
        version: expect.any(String)
      },
      compatibility: {
        api: {
          current: "v1",
          supported: ["v1"],
          unversionedAlias: "v1"
        },
        realtime: {
          current: "v1",
          supported: ["v1"]
        }
      }
    });
    expect(typeof response.body.time).toBe("string");
    expect(response.body.build).toHaveProperty("commit");
    expect(response.body.build).toHaveProperty("commitShort");
  });
});
