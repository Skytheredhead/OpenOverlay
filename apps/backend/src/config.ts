import path from "node:path";
import process from "node:process";

export interface AppConfig {
  env: "development" | "test" | "production";
  host: string;
  port: number;
  databasePath: string;
  uploadDir: string;
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
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = (process.env.NODE_ENV || "development") as AppConfig["env"];
  const cwd = process.cwd();
  const jwtSecret =
    overrides.jwtSecret ||
    process.env.JWT_SECRET ||
    (env === "production" ? "" : "dev-only-openoverlay-session-secret-change-me");

  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required in production");
  }

  const corsOrigins = (
    overrides.corsOrigins ||
    (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173,https://openoverlay.skylarenns.com")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  ) as string[];

  return {
    env,
    host: overrides.host || process.env.HOST || "127.0.0.1",
    port: overrides.port || Number(process.env.PORT || 8734),
    databasePath: path.resolve(overrides.databasePath || process.env.DATABASE_PATH || path.join(cwd, "data", "openoverlay.sqlite")),
    uploadDir: path.resolve(overrides.uploadDir || process.env.UPLOAD_DIR || path.join(cwd, "data", "uploads")),
    logFile: path.resolve(overrides.logFile || process.env.LOG_FILE || path.join(cwd, "data", "logs", "backend.log")),
    jwtSecret,
    corsOrigins,
    cookieDomain: overrides.cookieDomain || process.env.COOKIE_DOMAIN || undefined,
    frontendUrl: overrides.frontendUrl || process.env.FRONTEND_URL || "http://localhost:5173",
    selfUpdateEnabled: overrides.selfUpdateEnabled ?? parseBoolean(process.env.SELF_UPDATE_ENABLED),
    selfUpdateIntervalMs: overrides.selfUpdateIntervalMs ?? parsePositiveNumber(process.env.SELF_UPDATE_INTERVAL_MS, 60_000),
    selfUpdateRepoDir: path.resolve(overrides.selfUpdateRepoDir || process.env.SELF_UPDATE_REPO_DIR || path.join(cwd, "..", "..")),
    selfUpdateRemote: overrides.selfUpdateRemote || process.env.SELF_UPDATE_REMOTE || "origin",
    selfUpdateBranch: overrides.selfUpdateBranch || process.env.SELF_UPDATE_BRANCH || "main",
    gatewayBackendHost: overrides.gatewayBackendHost || process.env.GATEWAY_BACKEND_HOST || "127.0.0.1",
    gatewayBackendPorts: overrides.gatewayBackendPorts || parsePortList(process.env.GATEWAY_BACKEND_PORTS, [8735, 8736]),
    gatewayReleaseDir: path.resolve(overrides.gatewayReleaseDir || process.env.GATEWAY_RELEASE_DIR || path.join(cwd, "..", "..", "releases")),
    gatewaySlotStartupTimeoutMs: overrides.gatewaySlotStartupTimeoutMs ?? parsePositiveNumber(process.env.GATEWAY_SLOT_STARTUP_TIMEOUT_MS, 15_000)
  };
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePortList(value: string | undefined, fallback: number[]): number[] {
  const ports = (value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);
  return ports.length >= 2 ? ports : fallback;
}
