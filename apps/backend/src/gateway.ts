import { spawn, type ChildProcess } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPENOVERLAY_SUPPORTED_API_VERSIONS, OPENOVERLAY_SUPPORTED_REALTIME_VERSIONS } from "@openoverlay/shared";
import { loadConfig, type AppConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { getBuildInfo } from "./buildInfo.js";
import { createSelfUpdater, type PromotionController } from "./selfUpdate.js";

type SlotState = "candidate" | "active" | "draining";

interface SlotHealth {
  ok?: boolean;
  build?: {
    commit?: string | null;
    commitShort?: string | null;
    version?: string | null;
  };
  compatibility?: {
    api?: { current?: string; supported?: string[] };
    realtime?: { current?: string; supported?: string[] };
  };
}

export interface BackendSlot {
  id: string;
  port: number;
  state: SlotState;
  startedAt: string;
  health: SlotHealth;
  process?: ChildProcess;
  sockets: Set<net.Socket>;
}

export interface BackendGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): GatewayStatus;
  promotionController(): PromotionController;
}

export interface GatewayStatus {
  gatewayBuild: ReturnType<typeof getBuildInfo>;
  activeSlot?: SlotSummary;
  drainingSlots: SlotSummary[];
  candidateSlot?: SlotSummary;
  slotLimit: number;
}

interface SlotSummary {
  id: string;
  port: number;
  state: SlotState;
  startedAt: string;
  activeWebSockets: number;
  build: SlotHealth["build"];
  compatibility: SlotHealth["compatibility"];
}

interface PublicGatewayStatus {
  ok: boolean;
  gatewayBuild: ReturnType<typeof getBuildInfo>;
  activeBuild?: SlotHealth["build"];
  compatibility?: SlotHealth["compatibility"];
}

interface GatewayOptions {
  config?: AppConfig;
  logger?: Logger;
  spawnBackend?: (slot: BackendSlot, env: NodeJS.ProcessEnv) => ChildProcess;
  exitProcess?: (code: number) => void;
}

export function createBackendGateway(options: GatewayOptions = {}): BackendGateway {
  const config = options.config || loadConfig();
  const logger = options.logger || createLogger(config.logFile);
  const spawnBackend = options.spawnBackend || defaultSpawnBackend;
  const exitProcess = options.exitProcess || ((code: number) => process.exit(code));
  const slots = new Map<string, BackendSlot>();
  const slotFailures = new Map<string, Error>();
  let activeSlot: BackendSlot | undefined;
  let candidateSlot: BackendSlot | undefined;
  let server: http.Server | undefined;
  let stopping = false;
  let fatalExitRequested = false;
  let healthCheckTimer: NodeJS.Timeout | undefined;
  let healthCheckAbortController: AbortController | undefined;
  let monitoredSlotId: string | undefined;
  let consecutiveHealthFailures = 0;

  async function start(): Promise<void> {
    if (server) return;
    stopping = false;
    fatalExitRequested = false;
    const initialSlot = await startSlot("active");
    activeSlot = initialSlot;

    server = http.createServer((req, res) => void proxyHttp(req, res));
    server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket as net.Socket, head));

    await new Promise<void>((resolve) => {
      server!.listen(config.port, config.host, resolve);
    });
    scheduleHealthCheck();
    logger.info("openoverlay_gateway_started", { host: config.host, port: config.port, activeSlot: summarizeSlot(initialSlot) });
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (healthCheckTimer) clearTimeout(healthCheckTimer);
    healthCheckTimer = undefined;
    healthCheckAbortController?.abort();
    healthCheckAbortController = undefined;
    const serverStopped = new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    const slotsToStop = [...slots.values()];
    const childExits = slotsToStop.map(waitForSlotExit);
    for (const slot of slotsToStop) {
      stopSlot(slot, "gateway_stop");
    }
    server?.closeAllConnections();
    await Promise.all([serverStopped, ...childExits]);
    server = undefined;
  }

  async function proxyHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isGatewayStatusRequest(req.url)) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, {
          allow: "GET, HEAD",
          "cache-control": "no-store",
          "content-type": "application/json",
          "x-content-type-options": "nosniff"
        });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      res.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-content-type-options": "nosniff"
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(JSON.stringify(publicStatus()));
      return;
    }

    const selectedSlot = selectSlot(req);
    if (!selectedSlot) {
      writeUnsupportedVersion(res);
      return;
    }
    const slot: BackendSlot = selectedSlot;

    let proxyFinished = false;
    const proxyReq = http.request(
      {
        host: config.gatewayBackendHost,
        port: slot.port,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          host: `${config.gatewayBackendHost}:${slot.port}`,
          "x-openoverlay-gateway-slot": slot.id
        }
      },
      (proxyRes) => {
        proxyRes.on("error", (error) => finishProxyFailure(error, 502));
        proxyRes.on("aborted", () => finishProxyFailure(new Error("Upstream response aborted"), 502));
        proxyRes.on("end", finishProxySuccess);
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    const timeout = setTimeout(() => {
      finishProxyFailure(new Error(`Upstream request exceeded ${config.gatewayProxyTimeoutMs}ms`), 504);
    }, config.gatewayProxyTimeoutMs);
    timeout.unref();

    function finishProxySuccess(): void {
      if (proxyFinished) return;
      proxyFinished = true;
      clearTimeout(timeout);
    }

    function finishProxyFailure(error: Error, statusCode: 502 | 504): void {
      if (proxyFinished) return;
      proxyFinished = true;
      clearTimeout(timeout);
      logger.error("gateway_http_proxy_failed", { slot: slot.id, error: error.message });
      proxyReq.destroy();
      if (res.headersSent) {
        // Once a response has begun, appending a JSON error would corrupt the
        // upstream payload. Terminate it so clients can detect an incomplete response.
        res.destroy();
        return;
      }
      res.writeHead(statusCode, { "content-type": "application/json", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: statusCode === 504 ? "Backend slot timed out" : "Backend slot unavailable" }));
    }

    proxyReq.on("error", (error) => finishProxyFailure(error, 502));
    req.on("aborted", () => {
      if (!proxyFinished) {
        proxyFinished = true;
        clearTimeout(timeout);
        proxyReq.destroy();
      }
    });
    res.on("close", () => {
      if (!proxyFinished) {
        proxyFinished = true;
        clearTimeout(timeout);
        proxyReq.destroy();
      }
    });
    req.pipe(proxyReq);
  }

  function proxyUpgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): void {
    const slot = selectSlot(req);
    if (!slot) {
      socket.write("HTTP/1.1 426 Upgrade Required\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n");
      socket.end(JSON.stringify({ error: "Unsupported OpenOverlay API or realtime version" }));
      return;
    }

    const upstream = net.connect(slot.port, config.gatewayBackendHost, () => {
      upstream.write(`${req.method || "GET"} ${req.url || "/"} HTTP/${req.httpVersion}\r\n`);
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) upstream.write(`${name}: ${item}\r\n`);
        } else if (value !== undefined) {
          upstream.write(`${name}: ${value}\r\n`);
        }
      }
      upstream.write(`host: ${config.gatewayBackendHost}:${slot.port}\r\n`);
      upstream.write(`x-openoverlay-gateway-slot: ${slot.id}\r\n`);
      upstream.write("\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });

    slot.sockets.add(socket);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      slot.sockets.delete(socket);
      upstream.destroy();
      socket.destroy();
      if (!stopping) retireDrainedSlots();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    upstream.on("close", cleanup);
    upstream.on("error", cleanup);
  }

  function selectSlot(req: IncomingMessage): BackendSlot | undefined {
    const slot = activeSlot;
    if (!slot) return undefined;
    const requestedApiVersion = requestedVersion(req, "x-openoverlay-api-version", /^\/api\/(v[^/]+)/);
    const requestedRealtimeVersion = requestedQueryVersion(req, "realtimeVersion");
    if (requestedApiVersion && !slot.health.compatibility?.api?.supported?.includes(requestedApiVersion)) return undefined;
    if (requestedRealtimeVersion && !slot.health.compatibility?.realtime?.supported?.includes(requestedRealtimeVersion)) return undefined;
    return slot;
  }

  async function startSlot(state: SlotState, expectedCommit?: string): Promise<BackendSlot> {
    const port = nextAvailablePort();
    const slot: BackendSlot = {
      id: `${Date.now()}-${port}`,
      port,
      state,
      startedAt: new Date().toISOString(),
      health: {},
      sockets: new Set()
    };
    slots.set(slot.id, slot);
    slot.process = spawnBackend(slot, {
      ...process.env,
      HOST: config.gatewayBackendHost,
      PORT: String(slot.port),
      SELF_UPDATE_ENABLED: "false",
      OPENOVERLAY_SLOT_ID: slot.id
    });
    attachChildLogging(slot);
    slot.health = await waitForSlotHealth(slot, expectedCommit);
    if (!isCompatible(slot.health)) {
      stopSlot(slot, "incompatible_candidate");
      throw new Error(`Backend slot ${slot.id} does not support current OpenOverlay API/realtime versions`);
    }
    return slot;
  }

  function attachChildLogging(slot: BackendSlot): void {
    slot.process?.on("error", (error) => {
      if (!slots.has(slot.id)) return;
      const failure = new Error(`Backend slot ${slot.id} failed to start: ${error.message}`, { cause: error });
      slotFailures.set(slot.id, failure);
      logger.error("gateway_slot_process_error", { slot: slot.id, port: slot.port, state: slot.state, error: error.message });
      requestGatewayRestartIfActive(slot, failure, "gateway_active_slot_process_failed");
    });
    slot.process?.on("exit", (code, signal) => {
      logger.info("gateway_slot_exited", { slot: slot.id, port: slot.port, state: slot.state, code, signal });
      if (!slots.has(slot.id)) return;
      const failure = new Error(`Backend slot ${slot.id} exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
      slotFailures.set(slot.id, failure);
      requestGatewayRestartIfActive(slot, failure, "gateway_active_slot_exited");
    });
  }

  function requestGatewayRestartIfActive(slot: BackendSlot, failure: Error, event: string): void {
    const isActive = activeSlot?.id === slot.id || (!activeSlot && slot.state === "active");
    if (stopping || fatalExitRequested || !isActive) return;
    fatalExitRequested = true;
    logger.error(event, { slot: slot.id, port: slot.port, error: failure.message });
    void stop().catch((error) => {
      logger.error("gateway_fatal_shutdown_failed", { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => exitProcess(1));
  }

  function scheduleHealthCheck(): void {
    if (stopping || !server || healthCheckTimer) return;
    healthCheckTimer = setTimeout(() => {
      healthCheckTimer = undefined;
      void monitorActiveSlot();
    }, config.gatewayHealthCheckIntervalMs);
    healthCheckTimer.unref();
  }

  async function monitorActiveSlot(): Promise<void> {
    const slot = activeSlot;
    if (stopping || !server || !slot) return;
    if (monitoredSlotId !== slot.id) {
      monitoredSlotId = slot.id;
      consecutiveHealthFailures = 0;
    }

    const controller = new AbortController();
    healthCheckAbortController = controller;
    const timeout = setTimeout(() => controller.abort(), config.gatewayHealthCheckTimeoutMs);
    timeout.unref();
    try {
      const health = await fetchSlotHealth(slot, controller.signal);
      if (activeSlot?.id !== slot.id || stopping) return;
      assertMonitoredHealth(slot, health);
      slot.health = health;
      consecutiveHealthFailures = 0;
    } catch (error) {
      if (activeSlot?.id !== slot.id || stopping) return;
      consecutiveHealthFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("gateway_active_slot_health_failed", {
        slot: slot.id,
        port: slot.port,
        attempt: consecutiveHealthFailures,
        threshold: config.gatewayHealthFailureThreshold,
        error: message
      });
      if (consecutiveHealthFailures >= config.gatewayHealthFailureThreshold) {
        requestGatewayRestartIfActive(slot, new Error(`Active backend failed ${consecutiveHealthFailures} health checks: ${message}`), "gateway_active_slot_unhealthy");
      }
    } finally {
      clearTimeout(timeout);
      if (healthCheckAbortController === controller) healthCheckAbortController = undefined;
      scheduleHealthCheck();
    }
  }

  function assertMonitoredHealth(slot: BackendSlot, health: SlotHealth): void {
    if (health.ok !== true) throw new Error("health payload did not report ok=true");
    if (!isCompatible(health)) throw new Error("health payload reported incompatible API or realtime versions");
    const expectedCommit = slot.health.build?.commit;
    if (expectedCommit && health.build?.commit !== expectedCommit) {
      throw new Error(`health payload changed build commit from ${expectedCommit} to ${health.build?.commit || "unknown"}`);
    }
  }

  async function waitForSlotHealth(slot: BackendSlot, expectedCommit?: string): Promise<SlotHealth> {
    const deadline = Date.now() + config.gatewaySlotStartupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      const slotFailure = slotFailures.get(slot.id);
      if (slotFailure) {
        lastError = slotFailure;
        break;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
      try {
        const health = await fetchSlotHealth(slot, controller.signal);
        if (health.ok !== true) {
          lastError = new Error("health payload did not report ok=true");
        } else if (expectedCommit && health.build?.commit !== expectedCommit) {
          stopSlot(slot, "unexpected_build_commit");
          throw new Error(`Backend slot ${slot.id} reported commit ${health.build?.commit || "unknown"}; expected ${expectedCommit}`);
        } else {
          return health;
        }
      } catch (error) {
        if (expectedCommit && error instanceof Error && error.message.includes(`expected ${expectedCommit}`)) throw error;
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await delay(Math.min(250, remaining));
    }
    stopSlot(slot, "health_timeout");
    throw new Error(`Backend slot ${slot.id} did not become healthy: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
  }

  async function fetchSlotHealth(slot: BackendSlot, signal: AbortSignal): Promise<SlotHealth> {
    const response = await fetch(`http://${config.gatewayBackendHost}:${slot.port}/health`, {
      headers: { accept: "application/json" },
      signal
    });
    if (!response.ok) throw new Error(`health returned HTTP ${response.status}`);
    return (await response.json()) as SlotHealth;
  }

  function promotionController(): PromotionController {
    return {
      canPromote() {
        return !candidateSlot && drainingSlots().length === 0 && freePorts().length > 0;
      },
      async startCandidate(expectedCommit?: string) {
        if (!this.canPromote()) {
          throw new Error("Gateway already has a candidate or draining backend slot");
        }
        candidateSlot = await startSlot("candidate", expectedCommit);
        logger.info("gateway_candidate_started", { slot: summarizeSlot(candidateSlot) });
        return summarizeSlot(candidateSlot);
      },
      promoteCandidate() {
        if (!candidateSlot) throw new Error("No candidate backend slot is ready to promote");
        const candidateFailure = slotFailures.get(candidateSlot.id);
        if (candidateFailure || candidateSlot.process?.exitCode !== null && candidateSlot.process?.exitCode !== undefined) {
          const failedCandidate = candidateSlot;
          candidateSlot = undefined;
          stopSlot(failedCandidate, "candidate_exited_before_promotion");
          throw candidateFailure || new Error(`Backend slot ${failedCandidate.id} exited before promotion`);
        }
        const previous = activeSlot;
        candidateSlot.state = "active";
        activeSlot = candidateSlot;
        candidateSlot = undefined;
        monitoredSlotId = activeSlot.id;
        consecutiveHealthFailures = 0;
        if (previous) {
          previous.state = "draining";
          disconnectSlotSockets(previous, "candidate_promoted");
        }
        logger.info("gateway_candidate_promoted", {
          activeSlot: activeSlot ? summarizeSlot(activeSlot) : undefined,
          drainingSlot: previous ? summarizeSlot(previous) : undefined
        });
        retireDrainedSlots();
      },
      async restartGateway() {
        logger.info("openoverlay_gateway_restart_requested", { gatewayBuild: getBuildInfo(), activeSlot: activeSlot ? summarizeSlot(activeSlot) : undefined });
        await stop();
        exitProcess(0);
      },
      status
    };
  }

  function status(): GatewayStatus {
    return {
      gatewayBuild: getBuildInfo(),
      activeSlot: activeSlot ? summarizeSlot(activeSlot) : undefined,
      drainingSlots: drainingSlots().map(summarizeSlot),
      candidateSlot: candidateSlot ? summarizeSlot(candidateSlot) : undefined,
      slotLimit: config.gatewayBackendPorts.length
    };
  }

  function publicStatus(): PublicGatewayStatus {
    const slot = activeSlot;
    return {
      ok: Boolean(slot && slot.health.ok === true && consecutiveHealthFailures === 0 && !stopping && !fatalExitRequested),
      gatewayBuild: getBuildInfo(),
      activeBuild: slot?.health.build,
      compatibility: slot?.health.compatibility
    };
  }

  function nextAvailablePort(): number {
    const [port] = freePorts();
    if (!port) throw new Error("No backend gateway slot ports are available");
    return port;
  }

  function freePorts(): number[] {
    const used = new Set([...slots.values()].filter((slot) => slot.process && !slot.process.killed).map((slot) => slot.port));
    return config.gatewayBackendPorts.filter((port) => !used.has(port));
  }

  function drainingSlots(): BackendSlot[] {
    return [...slots.values()].filter((slot) => slot.state === "draining");
  }

  function retireDrainedSlots(): void {
    for (const slot of drainingSlots()) {
      if (slot.sockets.size === 0) {
        stopSlot(slot, "drained");
      }
    }
  }

  function disconnectSlotSockets(slot: BackendSlot, reason: string): void {
    if (slot.sockets.size > 0) {
      logger.info("gateway_slot_websockets_disconnecting", { slot: slot.id, port: slot.port, count: slot.sockets.size, reason });
    }
    for (const socket of [...slot.sockets]) socket.destroy();
  }

  function stopSlot(slot: BackendSlot, reason: string): void {
    logger.info("gateway_slot_stopping", { slot: slot.id, port: slot.port, state: slot.state, reason });
    for (const socket of slot.sockets) {
      socket.destroy();
    }
    slot.sockets.clear();
    slotFailures.delete(slot.id);
    slots.delete(slot.id);
    try {
      slot.process?.kill("SIGTERM");
    } catch (error) {
      logger.warn("gateway_slot_kill_failed", { slot: slot.id, port: slot.port, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function waitForSlotExit(slot: BackendSlot): Promise<void> {
    const child = slot.process;
    if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      let giveUpTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        if (giveUpTimer) clearTimeout(giveUpTimer);
        child.off("exit", finish);
        child.off("error", finish);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        logger.warn("gateway_slot_forced_kill", { slot: slot.id, port: slot.port });
        try {
          child.kill("SIGKILL");
        } finally {
          giveUpTimer = setTimeout(finish, 1_000);
        }
      }, 3_000);
      child.once("exit", finish);
      child.once("error", finish);
    });
  }

  return { start, stop, status, promotionController };
}

function defaultSpawnBackend(slot: BackendSlot, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js")], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "inherit", "inherit"]
  });
}

function summarizeSlot(slot: BackendSlot): SlotSummary {
  return {
    id: slot.id,
    port: slot.port,
    state: slot.state,
    startedAt: slot.startedAt,
    activeWebSockets: slot.sockets.size,
    build: slot.health.build,
    compatibility: slot.health.compatibility
  };
}

function isGatewayStatusRequest(requestUrl: string | undefined): boolean {
  try {
    return new URL(requestUrl || "/", "http://localhost").pathname === "/_openoverlay/gateway";
  } catch {
    return false;
  }
}

function requestedVersion(req: IncomingMessage, header: string, pathPattern: RegExp): string | undefined {
  const headerValue = req.headers[header];
  if (typeof headerValue === "string" && headerValue) return headerValue;
  const match = (req.url || "").match(pathPattern);
  return match?.[1];
}

function requestedQueryVersion(req: IncomingMessage, key: string): string | undefined {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    return url.searchParams.get(key) || undefined;
  } catch {
    return undefined;
  }
}

function isCompatible(health: SlotHealth): boolean {
  const apiVersions = health.compatibility?.api?.supported || [];
  const realtimeVersions = health.compatibility?.realtime?.supported || [];
  return OPENOVERLAY_SUPPORTED_API_VERSIONS.every((version) => apiVersions.includes(version)) &&
    OPENOVERLAY_SUPPORTED_REALTIME_VERSIONS.every((version) => realtimeVersions.includes(version));
}

function writeUnsupportedVersion(res: ServerResponse): void {
  res.writeHead(426, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Unsupported OpenOverlay API or realtime version" }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.env.OPENOVERLAY_GATEWAY_ENTRYPOINT === "1") {
  const config = loadConfig();
  const logger = createLogger(config.logFile);
  const gateway = createBackendGateway({ config, logger });
  const selfUpdater = createSelfUpdater(config, logger, gateway.promotionController());
  gateway.start().then(() => selfUpdater.start()).catch((error) => {
    console.error(error);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    selfUpdater.stop();
    const forceExitTimer = setTimeout(() => process.exit(1), 10_000);
    forceExitTimer.unref();
    void (async () => {
      try {
        await gateway.stop();
        await logger.flush?.();
        clearTimeout(forceExitTimer);
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
