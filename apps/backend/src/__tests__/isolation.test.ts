import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestServer, signup } from "./helpers.js";

let server: ReturnType<typeof makeTestServer>;

beforeEach(() => {
  server = makeTestServer();
});

afterEach(() => {
  server.close();
});

describe("user isolation", () => {
  it("keeps presets, media, and private APIs scoped to the owning user", async () => {
    await signup(server.agent, "owner@example.com");
    const other = request.agent(server.app);
    await signup(other, "other@example.com");

    const created = await server.agent.post("/api/presets").send({ name: "Match", type: "soccer" }).expect(201);
    const presetId = created.body.preset.id;
    const publicId = created.body.preset.publicId;

    await other.get(`/api/presets/${presetId}`).expect(404);
    await other.patch(`/api/presets/${presetId}`).send({ name: "Stolen" }).expect(404);
    await other.delete(`/api/presets/${presetId}`).expect(404);

    const ownerList = await server.agent.get("/api/presets").expect(200);
    const otherList = await other.get("/api/presets").expect(200);
    expect(ownerList.body.presets).toHaveLength(1);
    expect(otherList.body.presets).toHaveLength(0);

    const overlay = await server.request.get(`/api/overlay/${publicId}`).expect(200);
    expect(overlay.body.overlay.id).toBe(presetId);
    expect(overlay.body.overlay.state.home).toBeDefined();
  });

  it("duplicates shared presets into the recipient account", async () => {
    await signup(server.agent, "owner@example.com");
    const recipient = request.agent(server.app);
    await signup(recipient, "recipient@example.com");

    const created = await server.agent.post("/api/presets").send({ name: "Share Me", type: "soccer" }).expect(201);
    await server.agent.post(`/api/presets/${created.body.preset.id}/share`).send({ email: "recipient@example.com" }).expect(201);

    const recipientList = await recipient.get("/api/presets").expect(200);
    expect(recipientList.body.presets).toHaveLength(1);
    expect(recipientList.body.presets[0].name).toBe("Share Me");
    expect(recipientList.body.presets[0].id).not.toBe(created.body.preset.id);
  });

  it("rejects unsupported or unsafe media uploads as client errors", async () => {
    await signup(server.agent, "owner@example.com");

    const textResponse = await server.agent
      .post("/api/media")
      .attach("file", Buffer.from("not an image"), { filename: "notes.txt", contentType: "text/plain" })
      .expect(400);
    expect(textResponse.body.error).toBe("Unsupported image type");

    const svgResponse = await server.agent
      .post("/api/media")
      .attach("file", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), {
        filename: "unsafe.svg",
        contentType: "image/svg+xml"
      })
      .expect(400);
    expect(svgResponse.body.error).toBe("SVG contains unsafe content");
  });
});
