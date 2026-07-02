import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, signup } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => {
  server.close();
});

describe("media upload safety", () => {
  it("rejects SVG files with active content", async () => {
    await signup(server.agent, "svg-block@example.com");

    await server.agent
      .post("/api/media")
      .attach("file", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), {
        filename: "badge.svg",
        contentType: "image/svg+xml"
      })
      .expect(400);
  });

  it("normalizes traversal-looking upload filenames into the upload directory", async () => {
    await signup(server.agent, "safe-name@example.com");

    const response = await server.agent
      .post("/api/media")
      .attach("file", onePixelPng(), {
        filename: "../../evil.png",
        contentType: "image/png"
      })
      .expect(201);

    const filename = response.body.media.filename as string;
    expect(filename).not.toContain("..");
    expect(filename).not.toMatch(/[\\/]/);
    expect(fs.existsSync(path.join(server.dir, "uploads", filename))).toBe(true);
  });

  it("serves accepted SVG files with a sandboxing content security policy", async () => {
    await signup(server.agent, "svg-safe@example.com");

    const upload = await server.agent
      .post("/api/media")
      .attach("file", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>'), {
        filename: "logo.svg",
        contentType: "image/svg+xml"
      })
      .expect(201);

    const response = await server.request.get(`/api/media/file/${upload.body.media.publicId}`).expect(200);
    expect(response.headers["content-security-policy"]).toContain("sandbox");
    expect(response.headers["content-type"]).toContain("image/svg+xml");
  });
});

function onePixelPng(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  );
}
