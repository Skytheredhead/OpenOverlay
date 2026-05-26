import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { io as connectSocket, type Socket as ClientSocket } from "socket.io-client";
import { createBackendApp, type BackendApp } from "../app.js";
import { attachRealtime, type RealtimeHub } from "../realtime.js";
import { signup } from "./helpers.js";

interface RealtimeTestServer {
  app: BackendApp;
  dir: string;
  hub: RealtimeHub;
  server: http.Server;
  url: string;
}

const servers: RealtimeTestServer[] = [];
const sockets: ClientSocket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.disconnect());
  await Promise.all(servers.splice(0).map((testServer) => closeRealtimeTestServer(testServer)));
});

describe("realtime overlay clients", () => {
  it("does not count preview clients as overlay clients", async () => {
    const testServer = await makeRealtimeTestServer();
    const agent = request.agent(testServer.app.app);
    await signup(agent, "owner@example.com");
    const created = await agent.post("/api/presets").send({ name: "Match", type: "soccer" }).expect(201);
    const publicId = created.body.preset.publicId as string;

    const previewSocket = connectOverlay(testServer.url, publicId, "preview");
    await waitForSocket(previewSocket, "connect");
    expect(testServer.hub.getOverlayClientCount(publicId)).toBe(0);

    const outputSocket = connectOverlay(testServer.url, publicId, "overlay");
    await waitForSocket(outputSocket, "connect");
    expect(testServer.hub.getOverlayClientCount(publicId)).toBe(1);

    const disconnectPromise = waitForSocket(outputSocket, "disconnect");
    outputSocket.disconnect();
    await disconnectPromise;
    await waitForOverlayClientCount(testServer.hub, publicId, 0);
  });
});

async function makeRealtimeTestServer(): Promise<RealtimeTestServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-realtime-"));
  const app = createBackendApp({
    env: "test",
    databasePath: path.join(dir, "openoverlay.sqlite"),
    uploadDir: path.join(dir, "uploads"),
    logFile: path.join(dir, "backend.log"),
    jwtSecret: "test-secret",
    corsOrigins: ["http://localhost:5173"]
  });
  const server = http.createServer(app.app);
  const hub = attachRealtime(server, app.ctx);
  app.ctx.realtime = hub;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const testServer = { app, dir, hub, server, url: `http://127.0.0.1:${address.port}` };
  servers.push(testServer);
  return testServer;
}

function connectOverlay(url: string, overlayId: string, client: "overlay" | "preview"): ClientSocket {
  const socket = connectSocket(url, {
    transports: ["websocket"],
    auth: { role: "overlay", overlayId, client },
    query: { role: "overlay", overlayId, client }
  });
  sockets.push(socket);
  return socket;
}

function waitForSocket(socket: ClientSocket, event: "connect" | "disconnect"): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for socket ${event}`)), 1_000);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    function cleanup() {
      clearTimeout(timeout);
      socket.off("connect_error", onError);
    }
    socket.once(event, () => {
      cleanup();
      resolve();
    });
    socket.once("connect_error", onError);
  });
}

async function waitForOverlayClientCount(hub: RealtimeHub, publicId: string, count: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (hub.getOverlayClientCount(publicId) === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(hub.getOverlayClientCount(publicId)).toBe(count);
}

async function closeRealtimeTestServer(testServer: RealtimeTestServer): Promise<void> {
  testServer.hub.io.close();
  await new Promise<void>((resolve) => testServer.server.close(() => resolve()));
  testServer.app.close();
  fs.rmSync(testServer.dir, { recursive: true, force: true });
}
