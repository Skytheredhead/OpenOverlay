import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { OPENOVERLAY_API_VERSION, OPENOVERLAY_REALTIME_VERSION, openOverlayCompatibility } from "../../packages/shared/src/compatibility";

interface BuildInfo {
  version: string | null;
  commit: string | null;
  commitShort: string | null;
  requiredApiVersion: string;
  requiredRealtimeVersion: string;
}

const buildInfo = getBuildInfo();

export default defineConfig({
  plugins: [react(), buildInfoAsset(buildInfo)],
  define: {
    __OPENOVERLAY_BUILD_INFO__: JSON.stringify(buildInfo)
  },
  server: {
    port: 5173,
    strictPort: false
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    exclude: ["tests/**", "node_modules/**", "dist/**"]
  }
});

function buildInfoAsset(info: BuildInfo): Plugin {
  return {
    name: "openoverlay-build-info",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-info.json",
        source: `${JSON.stringify({ app: "OpenOverlay", component: "frontend", build: info, compatibility: openOverlayCompatibility() }, null, 2)}\n`
      });
    }
  };
}

function getBuildInfo(): BuildInfo {
  const commit = firstNonEmpty(process.env.OPENOVERLAY_GIT_SHA, process.env.GIT_COMMIT_SHA, process.env.VERCEL_GIT_COMMIT_SHA) || gitCommit();
  const version = firstNonEmpty(process.env.OPENOVERLAY_VERSION, process.env.npm_package_version) || packageVersion();

  return {
    version,
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    requiredApiVersion: OPENOVERLAY_API_VERSION,
    requiredRealtimeVersion: OPENOVERLAY_REALTIME_VERSION
  };
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
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function packageVersion(): string | null {
  try {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "package.json");
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}
