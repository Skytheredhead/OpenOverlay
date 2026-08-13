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

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const commit = resolveBuildCommit(moduleDir);
  const version = firstNonEmpty(process.env.OPENOVERLAY_VERSION, process.env.npm_package_version) || packageVersion();

  cachedBuildInfo = {
    version,
    commit,
    commitShort: commit ? commit.slice(0, 7) : null
  };
  return cachedBuildInfo;
}

export function resolveBuildCommit(
  moduleDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  gitCommitReader: () => string | null = gitCommit
): string | null {
  return (
    artifactCommit(moduleDir) ||
    firstNonEmpty(environment.OPENOVERLAY_GIT_SHA, environment.GIT_COMMIT_SHA, environment.VERCEL_GIT_COMMIT_SHA) ||
    (path.basename(moduleDir) === "src" ? gitCommitReader() : null)
  );
}

function artifactCommit(moduleDir: string): string | null {
  try {
    return firstNonEmpty(fs.readFileSync(path.join(moduleDir, ".openoverlay-build-commit"), "utf8"));
  } catch {
    return null;
  }
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
