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
    frontendUrl: overrides.frontendUrl || process.env.FRONTEND_URL || "http://localhost:5173"
  };
}
