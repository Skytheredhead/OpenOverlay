import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { createBackendGateway, type BackendSlot } from "../gateway.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.clearAllMocks();
});

describe("backend gateway", () => {
  it("promotes new slots while existing upgraded connections drain on the old slot", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    let spawnCount = 0;
    const config = testConfig(gatewayPort, slotPorts);

    const gateway = createBackendGateway({
      config,
      logger,
      spawnBackend(slot, env) {
        const marker = spawnCount === 0 ? "old" : "new";
        spawnCount += 1;
        return startFakeBackend(slot, env, marker);
      }
    });

    await gateway.start();
    expect(await fetchText(gatewayPort, "/marker")).toBe("old");

    const upgraded = await openUpgrade(gatewayPort);
    const promotions = gateway.promotionController();
    await promotions.startCandidate();
    promotions.promoteCandidate();

    expect(await fetchText(gatewayPort, "/marker")).toBe("new");
    expect(gateway.status().drainingSlots).toHaveLength(1);

    upgraded.destroy();
    await waitFor(() => expect(gateway.status().drainingSlots).toHaveLength(0));
    await gateway.stop();
  });
});

function testConfig(port: number, slotPorts: number[]): AppConfig {
  return {
    env: "test",
    host: "127.0.0.1",
    port,
    databasePath: "/tmp/openoverlay-gateway.sqlite",
    uploadDir: "/tmp/openoverlay-gateway-uploads",
    logFile: "/tmp/openoverlay-gateway.log",
    jwtSecret: "secret",
    corsOrigins: [],
    frontendUrl: "http://localhost:5173",
    selfUpdateEnabled: false,
    selfUpdateIntervalMs: 60_000,
    selfUpdateRepoDir: "/tmp/openoverlay",
    selfUpdateRemote: "origin",
    selfUpdateBranch: "main",
    gatewayBackendHost: "127.0.0.1",
    gatewayBackendPorts: slotPorts,
    gatewayReleaseDir: "/tmp/openoverlay-releases",
    gatewaySlotStartupTimeoutMs: 5_000
  };
}

function startFakeBackend(slot: BackendSlot, env: NodeJS.ProcessEnv, marker: string): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  (child as ChildProcess & { killed: boolean }).killed = false;
  child.kill = (() => {
    (child as ChildProcess & { killed: boolean }).killed = true;
    server.close();
    child.emit("exit", 0, null);
    return true;
  }) as ChildProcess["kill"];

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        build: { commit: marker, commitShort: marker, version: "0.1.0" },
        compatibility: {
          api: { current: "v1", supported: ["v1"] },
          realtime: { current: "v1", supported: ["v1"] }
        }
      }));
      return;
    }
    if (req.url === "/marker") {
      res.end(marker);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: test\r\n\r\n");
    socket.on("end", () => socket.destroy());
  });
  server.listen(Number(env.PORT), env.HOST || "127.0.0.1");
  servers.push(server);
  return child;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

async function fetchText(port: number, path: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return response.text();
}

function openUpgrade(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET /socket HTTP/1.1\r\nhost: localhost\r\nconnection: Upgrade\r\nupgrade: test\r\n\r\n");
    });
    socket.once("data", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}
