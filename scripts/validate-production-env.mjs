#!/usr/bin/env node

import fs from "node:fs";

const expectedFrontendOrigin = "https://openoverlay.skylarenns.com";
const allowedCorsOrigins = new Set([expectedFrontendOrigin, "http://localhost:5173", "http://127.0.0.1:5173"]);

try {
  const [file, expectedPortValue] = process.argv.slice(2);
  if (!file || !expectedPortValue || !/^\d+$/.test(expectedPortValue)) {
    throw new Error("Usage: validate-production-env.mjs <environment-file> <expected-port>");
  }

  const expectedPort = Number(expectedPortValue);
  if (!Number.isSafeInteger(expectedPort) || expectedPort < 1 || expectedPort > 65_535) {
    throw new Error("Expected port must be an integer from 1 to 65535");
  }

  const values = parseEnvironmentFile(fs.readFileSync(file, "utf8"));
  requireExact(values, "NODE_ENV", "production");
  requireExact(values, "HOST", "127.0.0.1");
  requireExact(values, "PORT", String(expectedPort));
  requireExact(values, "DATABASE_PATH", "/var/lib/openoverlay/openoverlay.sqlite");
  requireExact(values, "UPLOAD_DIR", "/var/lib/openoverlay/uploads");
  requireExact(values, "LOG_FILE", "/var/log/openoverlay/backend.log");
  requireExact(values, "FRONTEND_URL", expectedFrontendOrigin);
  requireExact(values, "COOKIE_DOMAIN", "");
  validateIntegerRange(requiredValue(values, "MEDIA_GLOBAL_MAX_BYTES"), "MEDIA_GLOBAL_MAX_BYTES", 250 * 1024 * 1024, Number.MAX_SAFE_INTEGER);
  validateIntegerRange(requiredValue(values, "STORAGE_MINIMUM_FREE_BYTES"), "STORAGE_MINIMUM_FREE_BYTES", 256 * 1024 * 1024, Number.MAX_SAFE_INTEGER);

  const secret = requiredValue(values, "JWT_SECRET");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JWT_SECRET must be at least 32 bytes");
  }
  if (secret === "dev-only-openoverlay-session-secret-change-me" || secret === "replace-with-a-long-random-secret") {
    throw new Error("JWT_SECRET must not use a documented placeholder or development secret");
  }

  const shareSecret = requiredValue(values, "SHARE_LOOKUP_SECRET");
  if (Buffer.byteLength(shareSecret, "utf8") < 32) {
    throw new Error("SHARE_LOOKUP_SECRET must be at least 32 bytes");
  }
  if (shareSecret === secret) {
    throw new Error("SHARE_LOOKUP_SECRET must be independent from JWT_SECRET");
  }

  validateCorsOrigins(requiredValue(values, "CORS_ORIGINS"));
  if (values.has("PATH")) {
    throw new Error("PATH must not be set in the application environment file; the systemd unit owns the runtime path");
  }

  console.log("OpenOverlay production environment validated");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production environment validation failed");
  process.exitCode = 1;
}

function parseEnvironmentFile(contents) {
  const values = new Map();
  for (const [index, sourceLine] of contents.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`Malformed environment entry on line ${index + 1}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key on line ${index + 1}`);
    if (values.has(key)) throw new Error(`Duplicate environment key: ${key}`);
    values.set(key, normalizeValue(line.slice(separator + 1), index + 1));
  }
  return values;
}

function normalizeValue(source, lineNumber) {
  const value = source.trim();
  if (!value) return "";
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.at(-1) !== quote) throw new Error(`Unterminated quoted environment value on line ${lineNumber}`);
    return value.slice(1, -1);
  }
  if (value.at(-1) === '"' || value.at(-1) === "'") {
    throw new Error(`Unexpected quote in environment value on line ${lineNumber}`);
  }
  return value;
}

function requiredValue(values, key) {
  if (!values.has(key)) throw new Error(`Missing required environment key: ${key}`);
  return values.get(key);
}

function requireExact(values, key, expected) {
  if (requiredValue(values, key) !== expected) throw new Error(`${key} does not match the required production value`);
}

function validateIntegerRange(value, key, minimum, maximum) {
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be a decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} is outside the allowed production range`);
  }
}

function validateCorsOrigins(value) {
  const origins = value.split(",").map((origin) => origin.trim());
  if (origins.length === 0 || origins.some((origin) => !origin)) {
    throw new Error("CORS_ORIGINS must be a non-empty comma-separated origin list");
  }
  if (new Set(origins).size !== origins.length) throw new Error("CORS_ORIGINS must not contain duplicates");

  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("CORS_ORIGINS contains an invalid origin");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin || !allowedCorsOrigins.has(origin)) {
      throw new Error("CORS_ORIGINS contains an origin outside the production allowlist");
    }
  }

  if (!origins.includes(expectedFrontendOrigin)) {
    throw new Error(`CORS_ORIGINS must include ${expectedFrontendOrigin} exactly`);
  }
}
