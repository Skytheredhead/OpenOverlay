import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const tempDirectories: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const validator = path.join(repoRoot, "scripts", "validate-production-env.mjs");

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("production environment validation", () => {
  it("accepts the canonical host-only production configuration", () => {
    const result = validateEnvironment();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("production environment validated");
  });

  it.each([
    ["a deceptive CORS suffix", { CORS_ORIGINS: "https://openoverlay.skylarenns.com.evil" }, /CORS_ORIGINS/],
    ["an unapproved CORS origin", { CORS_ORIGINS: "https://openoverlay.skylarenns.com,https://staging.example.com" }, /CORS_ORIGINS/],
    ["the wrong frontend origin", { FRONTEND_URL: "https://example.com" }, /FRONTEND_URL/],
    ["a broadly scoped cookie domain", { COOKIE_DOMAIN: ".skylarenns.com" }, /COOKIE_DOMAIN/],
    ["an invalid global media quota", { MEDIA_GLOBAL_MAX_BYTES: "0" }, /MEDIA_GLOBAL_MAX_BYTES/],
    ["an invalid free-space reserve", { STORAGE_MINIMUM_FREE_BYTES: "-1" }, /STORAGE_MINIMUM_FREE_BYTES/],
    ["the known development signing secret", { JWT_SECRET: "dev-only-openoverlay-session-secret-change-me" }, /development secret/],
    ["a missing share lookup secret", { SHARE_LOOKUP_SECRET: "" }, /SHARE_LOOKUP_SECRET/],
    ["a reused share lookup secret", { SHARE_LOOKUP_SECRET: "do-not-print-this-production-secret" }, /independent/],
    ["an environment-owned runtime path", { PATH: "/custom/bin" }, /PATH must not be set/]
  ])("rejects %s without echoing secrets", (_name, overrides, expectedError) => {
    const secret = "do-not-print-this-production-secret";
    const result = validateEnvironment({ JWT_SECRET: secret, ...overrides });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(expectedError);
    expect(result.stderr).not.toContain(secret);
  });
});

function validateEnvironment(overrides: Record<string, string> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-production-env-"));
  tempDirectories.push(directory);
  const file = path.join(directory, "backend.env");
  const values: Record<string, string> = {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "8734",
    DATABASE_PATH: "/var/lib/openoverlay/openoverlay.sqlite",
    UPLOAD_DIR: "/var/lib/openoverlay/uploads",
    MEDIA_GLOBAL_MAX_BYTES: "10737418240",
    STORAGE_MINIMUM_FREE_BYTES: "1073741824",
    LOG_FILE: "/var/log/openoverlay/backend.log",
    JWT_SECRET: "x".repeat(32),
    SHARE_LOOKUP_SECRET: "y".repeat(32),
    CORS_ORIGINS: "https://openoverlay.skylarenns.com,http://localhost:5173,http://127.0.0.1:5173",
    FRONTEND_URL: "https://openoverlay.skylarenns.com",
    COOKIE_DOMAIN: "",
    ...overrides
  };
  fs.writeFileSync(
    file,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { mode: 0o600 }
  );
  return spawnSync(process.execPath, [validator, file, "8734"], { cwd: repoRoot, encoding: "utf8" });
}
