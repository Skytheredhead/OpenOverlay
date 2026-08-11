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
  it("promotes new slots and disconnects upgraded clients so they reconnect to the new slot", async () => {
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
    const upgradedClosed = new Promise<void>((resolve) => upgraded.once("close", () => resolve()));
    const promotions = gateway.promotionController();
    await promotions.startCandidate();
    promotions.promoteCandidate();

    expect(await fetchText(gatewayPort, "/marker")).toBe("new");
    await upgradedClosed;
    await waitFor(() => expect(gateway.status().drainingSlots).toHaveLength(0));
    await gateway.stop();
  });

  it("requests a gateway process restart when the active backend exits", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    const exitProcess = vi.fn();
    let activeChild: ChildProcess | undefined;
    const gateway = createBackendGateway({
      config: testConfig(gatewayPort, slotPorts),
      logger,
      exitProcess,
      spawnBackend(slot, env) {
        activeChild = startFakeBackend(slot, env, "active");
        return activeChild;
      }
    });

    await gateway.start();
    activeChild?.emit("exit", 1, null);

    await waitFor(() => expect(exitProcess).toHaveBeenCalledOnce());
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith("gateway_active_slot_exited", expect.objectContaining({ slot: gateway.status().activeSlot?.id }));
    await gateway.stop();
  });

  it("restarts cleanly after a live active slot repeatedly wedges its health endpoint", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    const exitProcess = vi.fn();
    const config = testConfig(gatewayPort, slotPorts);
    config.gatewayHealthCheckIntervalMs = 20;
    config.gatewayHealthCheckTimeoutMs = 20;
    config.gatewayHealthFailureThreshold = 2;
    let healthMode: HealthMode = true;
    let activeChild: ChildProcess | undefined;
    const gateway = createBackendGateway({
      config,
      logger,
      exitProcess,
      spawnBackend(slot, env) {
        activeChild = startFakeBackend(slot, env, "active", () => healthMode);
        return activeChild;
      }
    });

    await gateway.start();
    healthMode = "hang";

    await waitFor(() => expect(exitProcess).toHaveBeenCalledWith(1));
    expect(activeChild?.killed).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "gateway_active_slot_health_failed",
      expect.objectContaining({ attempt: 2, threshold: 2 })
    );
    expect(logger.error).toHaveBeenCalledWith("gateway_active_slot_unhealthy", expect.objectContaining({ slot: expect.any(String) }));
    await gateway.stop();
  });

  it("bounds proxy lifetime and never appends JSON to a partial upstream response", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    const config = testConfig(gatewayPort, slotPorts);
    config.gatewayProxyTimeoutMs = 75;
    const gateway = createBackendGateway({
      config,
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "active");
      }
    });

    await gateway.start();
    const timedOut = await fetch(`http://127.0.0.1:${gatewayPort}/hang`);
    expect(timedOut.status).toBe(504);
    await expect(timedOut.json()).resolves.toEqual({ error: "Backend slot timed out" });

    const partial = await fetchPartialResponse(gatewayPort, "/partial");
    expect(partial.status).toBe(200);
    expect(partial.body).toBe("partial");
    expect(partial.aborted).toBe(true);
    expect(partial.body).not.toContain("Backend slot");
    await gateway.stop();
  });

  it("publishes deployment identity without exposing internal slot topology", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    const gateway = createBackendGateway({
      config: testConfig(gatewayPort, slotPorts),
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "active-sha");
      }
    });

    await gateway.start();
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/_openoverlay/gateway?cache-bust=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, activeBuild: { commit: "active-sha" } });
    expect(body).toHaveProperty("gatewayBuild");
    expect(body).not.toHaveProperty("activeSlot");
    expect(body).not.toHaveProperty("candidateSlot");
    expect(body).not.toHaveProperty("drainingSlots");
    expect(body).not.toHaveProperty("slotLimit");

    const mutation = await fetch(`http://127.0.0.1:${gatewayPort}/_openoverlay/gateway`, { method: "POST" });
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get("allow")).toBe("GET, HEAD");
    await gateway.stop();
  });

  it("cleanly stops every slot before requesting a process restart", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    const exitProcess = vi.fn();
    const children: ChildProcess[] = [];
    const gateway = createBackendGateway({
      config: testConfig(gatewayPort, slotPorts),
      logger,
      exitProcess,
      spawnBackend(slot, env) {
        const child = startFakeBackend(slot, env, "active");
        children.push(child);
        return child;
      }
    });

    await gateway.start();
    await gateway.promotionController().restartGateway();

    expect(children.every((child) => child.killed)).toBe(true);
    expect(exitProcess).toHaveBeenCalledWith(0);
    expect(gateway.status().activeSlot).toBeDefined();
  });

  it("enforces the total startup timeout when a health response hangs", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    const config = testConfig(gatewayPort, slotPorts);
    config.gatewaySlotStartupTimeoutMs = 100;
    const gateway = createBackendGateway({
      config,
      logger,
      exitProcess: vi.fn(),
      spawnBackend: startHangingHealthBackend
    });
    const startedAt = Date.now();

    await expect(gateway.start()).rejects.toThrow(/did not become healthy/);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("rejects health payloads without ok=true and candidate builds from the wrong commit", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    let spawnCount = 0;
    const config = testConfig(gatewayPort, slotPorts);
    config.gatewaySlotStartupTimeoutMs = 150;
    const unhealthyGateway = createBackendGateway({
      config,
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "unhealthy", false);
      }
    });

    await expect(unhealthyGateway.start()).rejects.toThrow(/ok=true/);

    const healthyGateway = createBackendGateway({
      config: testConfig(gatewayPort, slotPorts),
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        const marker = spawnCount++ === 0 ? "active-sha" : "stale-sha";
        return startFakeBackend(slot, env, marker);
      }
    });
    await healthyGateway.start();

    await expect(healthyGateway.promotionController().startCandidate("expected-sha")).rejects.toThrow(/reported commit stale-sha; expected expected-sha/);
    expect(healthyGateway.status().candidateSlot).toBeUndefined();
    await healthyGateway.stop();
  });

  it("refuses to promote a candidate process that exited after its health check", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    const children: ChildProcess[] = [];
    const gateway = createBackendGateway({
      config: testConfig(gatewayPort, slotPorts),
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        const child = startFakeBackend(slot, env, children.length === 0 ? "active" : "candidate");
        children.push(child);
        return child;
      }
    });

    await gateway.start();
    const promotions = gateway.promotionController();
    await promotions.startCandidate("candidate");
    children[1]?.emit("exit", 1, null);

    expect(() => promotions.promoteCandidate()).toThrow(/exited unexpectedly/);
    expect(await fetchText(gatewayPort, "/marker")).toBe("active");
    await gateway.stop();
  });

  it("stops promptly even when an upgraded client is still connected", async () => {
    const gatewayPort = await freePort();
    const slotPorts = [await freePort(), await freePort()];
    const gateway = createBackendGateway({
      config: testConfig(gatewayPort, slotPorts),
      logger,
      exitProcess: vi.fn(),
      spawnBackend(slot, env) {
        return startFakeBackend(slot, env, "active");
      }
    });

    await gateway.start();
    const upgraded = await openUpgrade(gatewayPort);
    const upgradedClosed = new Promise<string>((resolve) => upgraded.once("close", () => resolve("closed")));
    const stopped = gateway.stop();

    await expect(Promise.race([
      stopped.then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 1_000))
    ])).resolves.toBe("stopped");
    await expect(Promise.race([
      upgradedClosed,
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 1_000))
    ])).resolves.toBe("closed");
  });
});

function testConfig(port: number, slotPorts: number[]): AppConfig {
  return {
    env: "test",
    host: "127.0.0.1",
    port,
    databasePath: "/tmp/openoverlay-gateway.sqlite",
    uploadDir: "/tmp/openoverlay-gateway-uploads",
    mediaGlobalMaxBytes: 10 * 1024 * 1024 * 1024,
    storageMinimumFreeBytes: 0,
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
    gatewaySlotStartupTimeoutMs: 5_000,
    gatewayHealthCheckIntervalMs: 10_000,
    gatewayHealthCheckTimeoutMs: 2_000,
    gatewayHealthFailureThreshold: 3,
    gatewayProxyTimeoutMs: 60_000,
    realtimeMaxConnections: 512,
    realtimeMaxConnectionsPerIp: 64,
    realtimeMaxPayloadBytes: 64 * 1024
  };
}

type HealthMode = boolean | "hang";

function startFakeBackend(
  slot: BackendSlot,
  env: NodeJS.ProcessEnv,
  marker: string,
  healthMode: HealthMode | (() => HealthMode) = true
): ChildProcess {
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
      const currentHealthMode = typeof healthMode === "function" ? healthMode() : healthMode;
      if (currentHealthMode === "hang") return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: currentHealthMode,
        build: { commit: marker, commitShort: marker, version: "0.1.0" },
        compatibility: {
          api: { current: "v1", supported: ["v1"] },
          realtime: { current: "v1", supported: ["v1"] }
        }
      }));
      return;
    }
    if (req.url === "/hang") return;
    if (req.url === "/partial") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
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

function startHangingHealthBackend(slot: BackendSlot, env: NodeJS.ProcessEnv): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  (child as ChildProcess & { killed: boolean }).killed = false;
  child.kill = (() => {
    (child as ChildProcess & { killed: boolean }).killed = true;
    server.close();
    child.emit("exit", 0, null);
    return true;
  }) as ChildProcess["kill"];

  const server = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.statusCode = 404;
      res.end();
    }
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

function fetchPartialResponse(port: number, path: string): Promise<{ status: number; body: string; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}${path}`, (response) => {
      let body = "";
      let settled = false;
      const finish = (aborted: boolean) => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode || 0, body, aborted });
      };
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("aborted", () => finish(true));
      response.on("error", () => finish(true));
      response.on("end", () => finish(false));
    });
    request.on("error", reject);
  });
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
