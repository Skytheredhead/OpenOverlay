import path from "node:path";
import process from "node:process";

const DEVELOPMENT_JWT_SECRET = "dev-only-openoverlay-session-secret-change-me";

export interface AppConfig {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  databasePath: string;
  uploadDir: string;
  mediaGlobalMaxBytes: number;
  storageMinimumFreeBytes: number;
  logFile: string;
  jwtSecret: string;
  corsOrigins: string[];
  cookieDomain?: string;
  frontendUrl: string;
  selfUpdateEnabled: boolean;
  selfUpdateIntervalMs: number;
  selfUpdateRepoDir: string;
  selfUpdateRemote: string;
  selfUpdateBranch: string;
  gatewayBackendHost: string;
  gatewayBackendPorts: number[];
  gatewayReleaseDir: string;
  gatewaySlotStartupTimeoutMs: number;
  gatewayHealthCheckIntervalMs: number;
  gatewayHealthCheckTimeoutMs: number;
  gatewayHealthFailureThreshold: number;
  gatewayProxyTimeoutMs: number;
  realtimeMaxConnections: number;
  realtimeMaxConnectionsPerIp: number;
  realtimeMaxPayloadBytes: number;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = parseEnvironment(overrides.env ?? process.env.NODE_ENV);
  const cwd = process.cwd();
  const jwtSecret =
    overrides.jwtSecret ??
    process.env.JWT_SECRET ??
    (env === "production" ? "" : DEVELOPMENT_JWT_SECRET);

  if (env === "production" && Buffer.byteLength(jwtSecret, "utf8") < 32) {
    throw new Error("JWT_SECRET must be at least 32 bytes in production");
  }
  if (env === "production" && jwtSecret === DEVELOPMENT_JWT_SECRET) {
    throw new Error("JWT_SECRET must not use the known development secret in production");
  }
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required");
  }

  const corsOrigins = (
    overrides.corsOrigins ??
    (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173,https://openoverlay.skylarenns.com")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  ) as string[];
  validateOrigins(corsOrigins, env);

  const port = validatePort(overrides.port ?? parsePort(process.env.PORT, 8734, "PORT"), "PORT");
  const gatewayBackendPorts = overrides.gatewayBackendPorts
    ? validatePortList(overrides.gatewayBackendPorts, "GATEWAY_BACKEND_PORTS")
    : parsePortList(process.env.GATEWAY_BACKEND_PORTS, [8735, 8736]);
  const isGatewayBackendSlot = Boolean(process.env.OPENOVERLAY_SLOT_ID);
  if (!isGatewayBackendSlot && gatewayBackendPorts.includes(port)) {
    throw new Error("PORT must not match any GATEWAY_BACKEND_PORTS value");
  }
  const cookieDomain = (overrides.cookieDomain ?? process.env.COOKIE_DOMAIN)?.trim() || undefined;
  const frontendUrl = overrides.frontendUrl ?? process.env.FRONTEND_URL ?? "http://localhost:5173";
  validateOrigin(frontendUrl, "FRONTEND_URL");
  const host = validateHost(overrides.host ?? process.env.HOST ?? "127.0.0.1", "HOST");
  const gatewayBackendHost = validateHost(overrides.gatewayBackendHost ?? process.env.GATEWAY_BACKEND_HOST ?? "127.0.0.1", "GATEWAY_BACKEND_HOST");

  return {
    env,
    host,
    port,
    databasePath: path.resolve(overrides.databasePath ?? process.env.DATABASE_PATH ?? path.join(cwd, "data", "openoverlay.sqlite")),
    uploadDir: path.resolve(overrides.uploadDir ?? process.env.UPLOAD_DIR ?? path.join(cwd, "data", "uploads")),
    mediaGlobalMaxBytes: validatePositiveInteger(overrides.mediaGlobalMaxBytes ?? parsePositiveInteger(process.env.MEDIA_GLOBAL_MAX_BYTES, 10 * 1024 * 1024 * 1024, "MEDIA_GLOBAL_MAX_BYTES"), "MEDIA_GLOBAL_MAX_BYTES"),
    storageMinimumFreeBytes: validateNonNegativeInteger(overrides.storageMinimumFreeBytes ?? parseNonNegativeInteger(process.env.STORAGE_MINIMUM_FREE_BYTES, 1024 * 1024 * 1024, "STORAGE_MINIMUM_FREE_BYTES"), "STORAGE_MINIMUM_FREE_BYTES"),
    logFile: path.resolve(overrides.logFile ?? process.env.LOG_FILE ?? path.join(cwd, "data", "logs", "backend.log")),
    jwtSecret,
    corsOrigins,
    cookieDomain,
    frontendUrl,
    selfUpdateEnabled: overrides.selfUpdateEnabled ?? parseBoolean(process.env.SELF_UPDATE_ENABLED, "SELF_UPDATE_ENABLED"),
    selfUpdateIntervalMs: validatePositiveNumber(overrides.selfUpdateIntervalMs ?? parsePositiveNumber(process.env.SELF_UPDATE_INTERVAL_MS, 60_000, "SELF_UPDATE_INTERVAL_MS"), "SELF_UPDATE_INTERVAL_MS"),
    selfUpdateRepoDir: path.resolve(overrides.selfUpdateRepoDir ?? process.env.SELF_UPDATE_REPO_DIR ?? path.join(cwd, "..", "..")),
    selfUpdateRemote: overrides.selfUpdateRemote ?? process.env.SELF_UPDATE_REMOTE ?? "origin",
    selfUpdateBranch: overrides.selfUpdateBranch ?? process.env.SELF_UPDATE_BRANCH ?? "main",
    gatewayBackendHost,
    gatewayBackendPorts,
    gatewayReleaseDir: path.resolve(overrides.gatewayReleaseDir ?? process.env.GATEWAY_RELEASE_DIR ?? path.join(cwd, "..", "..", "releases")),
    gatewaySlotStartupTimeoutMs: validatePositiveNumber(overrides.gatewaySlotStartupTimeoutMs ?? parsePositiveNumber(process.env.GATEWAY_SLOT_STARTUP_TIMEOUT_MS, 15_000, "GATEWAY_SLOT_STARTUP_TIMEOUT_MS"), "GATEWAY_SLOT_STARTUP_TIMEOUT_MS"),
    gatewayHealthCheckIntervalMs: validatePositiveNumber(overrides.gatewayHealthCheckIntervalMs ?? parsePositiveNumber(process.env.GATEWAY_HEALTH_CHECK_INTERVAL_MS, 10_000, "GATEWAY_HEALTH_CHECK_INTERVAL_MS"), "GATEWAY_HEALTH_CHECK_INTERVAL_MS"),
    gatewayHealthCheckTimeoutMs: validatePositiveNumber(overrides.gatewayHealthCheckTimeoutMs ?? parsePositiveNumber(process.env.GATEWAY_HEALTH_CHECK_TIMEOUT_MS, 2_000, "GATEWAY_HEALTH_CHECK_TIMEOUT_MS"), "GATEWAY_HEALTH_CHECK_TIMEOUT_MS"),
    gatewayHealthFailureThreshold: validatePositiveInteger(overrides.gatewayHealthFailureThreshold ?? parsePositiveInteger(process.env.GATEWAY_HEALTH_FAILURE_THRESHOLD, 3, "GATEWAY_HEALTH_FAILURE_THRESHOLD"), "GATEWAY_HEALTH_FAILURE_THRESHOLD"),
    gatewayProxyTimeoutMs: validatePositiveNumber(overrides.gatewayProxyTimeoutMs ?? parsePositiveNumber(process.env.GATEWAY_PROXY_TIMEOUT_MS, 60_000, "GATEWAY_PROXY_TIMEOUT_MS"), "GATEWAY_PROXY_TIMEOUT_MS"),
    realtimeMaxConnections: validatePositiveInteger(overrides.realtimeMaxConnections ?? parsePositiveInteger(process.env.REALTIME_MAX_CONNECTIONS, 512, "REALTIME_MAX_CONNECTIONS"), "REALTIME_MAX_CONNECTIONS"),
    realtimeMaxConnectionsPerIp: validatePositiveInteger(overrides.realtimeMaxConnectionsPerIp ?? parsePositiveInteger(process.env.REALTIME_MAX_CONNECTIONS_PER_IP, 64, "REALTIME_MAX_CONNECTIONS_PER_IP"), "REALTIME_MAX_CONNECTIONS_PER_IP"),
    realtimeMaxPayloadBytes: validatePositiveInteger(overrides.realtimeMaxPayloadBytes ?? parsePositiveInteger(process.env.REALTIME_MAX_PAYLOAD_BYTES, 64 * 1024, "REALTIME_MAX_PAYLOAD_BYTES"), "REALTIME_MAX_PAYLOAD_BYTES")
  };
}

function parseEnvironment(value: string | undefined): AppConfig["env"] {
  if (value === undefined || value === "") return "development";
  if (value === "development" || value === "test" || value === "production") return value;
  throw new Error(`Invalid NODE_ENV: ${value}`);
}

function parseBoolean(value: string | undefined, label: string): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error(`${label} must be true, false, 1, or 0`);
}

function parsePositiveNumber(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  return validatePositiveNumber(Number(value), label);
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  return validatePositiveInteger(Number(value), label);
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  return validateNonNegativeInteger(Number(value), label);
}

function parsePortList(value: string | undefined, fallback: number[]): number[] {
  if (value === undefined || value.trim() === "") return validatePortList(fallback, "GATEWAY_BACKEND_PORTS");
  return validatePortList(value.split(",").map((item) => Number(item.trim())), "GATEWAY_BACKEND_PORTS");
}

function parsePort(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  return validatePort(Number(value), label);
}

function validatePort(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return value;
}

function validatePortList(values: number[], label: string): number[] {
  const ports = values.map((value) => validatePort(value, label));
  if (ports.length < 2 || new Set(ports).size !== ports.length) {
    throw new Error(`${label} must contain at least two distinct ports`);
  }
  return ports;
}

function validatePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function validateNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function validateHost(value: string, label: string): string {
  if (!value || value !== value.trim() || /[\s/\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty host name or IP address`);
  }
  return value;
}

function validateOrigins(origins: string[], env: AppConfig["env"]): void {
  if (env === "production" && origins.length === 0) throw new Error("CORS_ORIGINS must not be empty in production");
  if (new Set(origins).size !== origins.length) throw new Error("CORS_ORIGINS must not contain duplicates");
  for (const origin of origins) validateOrigin(origin, "CORS_ORIGINS");
}

function validateOrigin(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must contain valid HTTP(S) origins`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value || parsed.username || parsed.password) {
    throw new Error(`${label} must contain valid HTTP(S) origins`);
  }
}
