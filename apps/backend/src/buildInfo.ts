import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
  version: string | null;
  commit: string | null;
  commitShort: string | null;
}

let cachedBuildInfo: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cachedBuildInfo) return cachedBuildInfo;

  const commit = gitCommit() || firstNonEmpty(process.env.OPENOVERLAY_GIT_SHA, process.env.GIT_COMMIT_SHA, process.env.VERCEL_GIT_COMMIT_SHA);
  const version = firstNonEmpty(process.env.OPENOVERLAY_VERSION, process.env.npm_package_version) || packageVersion();

  cachedBuildInfo = {
    version,
    commit,
    commitShort: commit ? commit.slice(0, 7) : null
  };
  return cachedBuildInfo;
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function packageVersion(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(moduleDir, "..", "package.json"), path.resolve(process.cwd(), "package.json")];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // Continue to the next possible package location.
    }
  }

  return null;
}
