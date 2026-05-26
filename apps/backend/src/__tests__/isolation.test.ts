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

  it("keeps saved teams scoped to the owning user", async () => {
    await signup(server.agent, "owner@example.com");
    const other = request.agent(server.app);
    await signup(other, "other@example.com");

    const created = await server.agent
      .post("/api/teams")
      .send({
        fullName: "Codex Rovers",
        shortName: "Rovers",
        abbreviation: "ROV",
        rosterText: "10 Mira Stone\n11 Avery Vale",
        record: { wins: 8, losses: 2, draws: 1 }
      })
      .expect(201);

    const teamId = created.body.team.id;
    expect(created.body.team.roster).toHaveLength(2);
    expect(created.body.team.record).toEqual({ wins: 8, losses: 2, draws: 1 });

    await other.patch(`/api/teams/${teamId}`).send({ fullName: "Stolen" }).expect(404);
    await other.delete(`/api/teams/${teamId}`).expect(404);

    const ownerList = await server.agent.get("/api/teams").expect(200);
    const otherList = await other.get("/api/teams").expect(200);
    expect(ownerList.body.teams).toHaveLength(1);
    expect(ownerList.body.teams[0].fullName).toBe("Codex Rovers");
    expect(otherList.body.teams).toHaveLength(0);
  });

  it("preserves intentionally cleared saved-team fields", async () => {
    await signup(server.agent, "owner@example.com");

    const created = await server.agent
      .post("/api/teams")
      .send({
        fullName: "Codex Rovers",
        shortName: "Rovers",
        abbreviation: "ROV",
        rosterText: "10 Mira Stone\n11 Avery Vale",
        coach: "Coach Nova",
        schoolName: "Codex High",
        logoMediaId: "media-1",
        logoUrl: "/api/media/file/logo"
      })
      .expect(201);

    const updated = await server.agent
      .patch(`/api/teams/${created.body.team.id}`)
      .send({
        shortName: "",
        abbreviation: "",
        rosterText: "",
        coach: "",
        schoolName: "",
        logoMediaId: null,
        logoUrl: null
      })
      .expect(200);

    expect(updated.body.team.shortName).toBe("");
    expect(updated.body.team.abbreviation).toBe("");
    expect(updated.body.team.rosterText).toBe("");
    expect(updated.body.team.roster).toHaveLength(0);
    expect(updated.body.team.coach).toBe("");
    expect(updated.body.team.schoolName).toBe("");
    expect(updated.body.team.logoMediaId).toBeUndefined();
    expect(updated.body.team.logoUrl).toBeUndefined();
  });

  it("keeps saved-team roster text newlines intact for editing", async () => {
    await signup(server.agent, "owner@example.com");

    const created = await server.agent
      .post("/api/teams")
      .send({
        fullName: "Codex Rovers",
        rosterText: "10 Mira Stone\n"
      })
      .expect(201);

    expect(created.body.team.rosterText).toBe("10 Mira Stone\n");
    expect(created.body.team.roster).toHaveLength(1);
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
