import { spawn, type ChildProcess } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPENOVERLAY_SUPPORTED_API_VERSIONS, OPENOVERLAY_SUPPORTED_REALTIME_VERSIONS } from "@openoverlay/shared";
import { loadConfig, type AppConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
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

interface GatewayOptions {
  config?: AppConfig;
  logger?: Logger;
  spawnBackend?: (slot: BackendSlot, env: NodeJS.ProcessEnv) => ChildProcess;
}

export function createBackendGateway(options: GatewayOptions = {}): BackendGateway {
  const config = options.config || loadConfig();
  const logger = options.logger || createLogger(config.logFile);
  const spawnBackend = options.spawnBackend || defaultSpawnBackend;
  const slots = new Map<string, BackendSlot>();
  let activeSlot: BackendSlot | undefined;
  let candidateSlot: BackendSlot | undefined;
  let server: http.Server | undefined;
  let stopping = false;

  async function start(): Promise<void> {
    if (server) return;
    const initialSlot = await startSlot("active");
    activeSlot = initialSlot;

    server = http.createServer((req, res) => void proxyHttp(req, res));
    server.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket as net.Socket, head));

    await new Promise<void>((resolve) => {
      server!.listen(config.port, config.host, resolve);
    });
    logger.info("openoverlay_gateway_started", { host: config.host, port: config.port, activeSlot: summarizeSlot(initialSlot) });
  }

  async function stop(): Promise<void> {
    stopping = true;
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
    for (const slot of slots.values()) {
      stopSlot(slot, "gateway_stop");
    }
  }

  async function proxyHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === "/_openoverlay/gateway") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(status()));
      return;
    }

    const slot = selectSlot(req);
    if (!slot) {
      writeUnsupportedVersion(res);
      return;
    }

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
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (error) => {
      logger.error("gateway_http_proxy_failed", { slot: slot.id, error: error.message });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Backend slot unavailable" }));
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
      slot.sockets.add(socket);
      socket.pipe(upstream).pipe(socket);
    });

    const cleanup = () => {
      slot.sockets.delete(socket);
      upstream.destroy();
      if (!stopping) retireDrainedSlots();
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
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

  async function startSlot(state: SlotState): Promise<BackendSlot> {
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
    slot.health = await waitForSlotHealth(slot);
    if (!isCompatible(slot.health)) {
      stopSlot(slot, "incompatible_candidate");
      throw new Error(`Backend slot ${slot.id} does not support current OpenOverlay API/realtime versions`);
    }
    return slot;
  }

  function attachChildLogging(slot: BackendSlot): void {
    slot.process?.on("exit", (code, signal) => {
      logger.info("gateway_slot_exited", { slot: slot.id, port: slot.port, state: slot.state, code, signal });
      if (activeSlot?.id === slot.id && !stopping) {
        logger.error("gateway_active_slot_exited", { slot: slot.id, port: slot.port });
      }
    });
  }

  async function waitForSlotHealth(slot: BackendSlot): Promise<SlotHealth> {
    const deadline = Date.now() + config.gatewaySlotStartupTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://${config.gatewayBackendHost}:${slot.port}/health`);
        if (response.ok) return (await response.json()) as SlotHealth;
      } catch (error) {
        lastError = error;
      }
      await delay(250);
    }
    stopSlot(slot, "health_timeout");
    throw new Error(`Backend slot ${slot.id} did not become healthy: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
  }

  function promotionController(): PromotionController {
    return {
      canPromote() {
        return !candidateSlot && drainingSlots().length === 0 && freePorts().length > 0;
      },
      async startCandidate() {
        if (!this.canPromote()) {
          throw new Error("Gateway already has a candidate or draining backend slot");
        }
        candidateSlot = await startSlot("candidate");
        logger.info("gateway_candidate_started", { slot: summarizeSlot(candidateSlot) });
        return summarizeSlot(candidateSlot);
      },
      promoteCandidate() {
        if (!candidateSlot) throw new Error("No candidate backend slot is ready to promote");
        const previous = activeSlot;
        candidateSlot.state = "active";
        activeSlot = candidateSlot;
        candidateSlot = undefined;
        if (previous) {
          previous.state = "draining";
        }
        logger.info("gateway_candidate_promoted", {
          activeSlot: activeSlot ? summarizeSlot(activeSlot) : undefined,
          drainingSlot: previous ? summarizeSlot(previous) : undefined
        });
        retireDrainedSlots();
      },
      status
    };
  }

  function status(): GatewayStatus {
    return {
      activeSlot: activeSlot ? summarizeSlot(activeSlot) : undefined,
      drainingSlots: drainingSlots().map(summarizeSlot),
      candidateSlot: candidateSlot ? summarizeSlot(candidateSlot) : undefined,
      slotLimit: config.gatewayBackendPorts.length
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

  function stopSlot(slot: BackendSlot, reason: string): void {
    logger.info("gateway_slot_stopping", { slot: slot.id, port: slot.port, state: slot.state, reason });
    for (const socket of slot.sockets) {
      socket.destroy();
    }
    slot.sockets.clear();
    slot.process?.kill("SIGTERM");
    slots.delete(slot.id);
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

  const shutdown = () => {
    selfUpdater.stop();
    void gateway.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
