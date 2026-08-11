import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { createSelfUpdater } from "../selfUpdate.js";
import type { Logger } from "../logger.js";

const config: AppConfig = {
  env: "production",
  host: "127.0.0.1",
  port: 8734,
  databasePath: "/tmp/openoverlay.sqlite",
  uploadDir: "/tmp/openoverlay-uploads",
  mediaGlobalMaxBytes: 10 * 1024 * 1024 * 1024,
  storageMinimumFreeBytes: 0,
  logFile: "/tmp/openoverlay.log",
  jwtSecret: "secret",
  corsOrigins: [],
  frontendUrl: "https://openoverlay.skylarenns.com",
  selfUpdateEnabled: true,
  selfUpdateIntervalMs: 60_000,
  selfUpdateRepoDir: "/srv/openoverlay",
  selfUpdateRemote: "origin",
  selfUpdateBranch: "main",
  gatewayBackendHost: "127.0.0.1",
  gatewayBackendPorts: [8735, 8736],
  gatewayReleaseDir: "/srv/openoverlay/releases",
  gatewaySlotStartupTimeoutMs: 15_000,
  gatewayHealthCheckIntervalMs: 10_000,
  gatewayHealthCheckTimeoutMs: 2_000,
  gatewayHealthFailureThreshold: 3,
  gatewayProxyTimeoutMs: 60_000,
  realtimeMaxConnections: 512,
  realtimeMaxConnectionsPerIp: 64,
  realtimeMaxPayloadBytes: 64 * 1024
};

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("self updater", () => {
  it("pulls, rebuilds, and promotes when origin/main changes", async () => {
    const promotions = {
      canPromote: vi.fn(() => true),
      startCandidate: vi.fn(async () => ({ id: "candidate" })),
      promoteCandidate: vi.fn(),
      restartGateway: vi.fn(async () => undefined),
      status: vi.fn(() => ({ activeSlot: { id: "active" } }))
    };
    const commands: string[] = [];
    let head = "old-sha";
    const runner = vi.fn(async (command: string, args: string[], cwd: string) => {
      commands.push(`${cwd}:${command} ${args.join(" ")}`);
      const commandLine = `${command} ${args.join(" ")}`;
      if (commandLine === "git rev-parse HEAD") return { stdout: `${head}\n`, stderr: "" };
      if (commandLine === "git rev-parse origin/main") return { stdout: "new-sha\n", stderr: "" };
      if (commandLine === "git branch --show-current") return { stdout: "main\n", stderr: "" };
      if (commandLine === "git pull --ff-only origin main") head = "new-sha";
      return { stdout: "", stderr: "" };
    });

    const updater = createSelfUpdater(config, logger, promotions, runner);

    await updater.checkNow();

    expect(commands).toEqual([
      "/srv/openoverlay:git fetch --quiet origin main",
      "/srv/openoverlay:git rev-parse HEAD",
      "/srv/openoverlay:git rev-parse origin/main",
      "/srv/openoverlay:git branch --show-current",
      "/srv/openoverlay:git status --porcelain --untracked-files=normal",
      "/srv/openoverlay:git pull --ff-only origin main",
      "/srv/openoverlay:npm ci --include=dev",
      "/srv/openoverlay:npm audit --audit-level=high",
      "/srv/openoverlay:npm run build --workspace @openoverlay/shared",
      "/srv/openoverlay:npm run build --workspace @openoverlay/backend",
      "/srv/openoverlay:npm run test --workspace @openoverlay/backend",
      "/srv/openoverlay:git rev-parse HEAD",
      "/srv/openoverlay:git status --porcelain --untracked-files=normal"
    ]);
    expect(promotions.startCandidate).toHaveBeenCalledWith("new-sha");
    expect(promotions.promoteCandidate).toHaveBeenCalledTimes(1);
    expect(promotions.restartGateway).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("self_update_applied", { previousCommit: "old-sha", currentCommit: "new-sha", candidate: { id: "candidate" } });
  });

  it("rebuilds an already-pulled commit after an earlier install failure", async () => {
    const promotions = {
      canPromote: vi.fn(() => true),
      startCandidate: vi.fn(async () => ({ id: "candidate" })),
      promoteCandidate: vi.fn(),
      restartGateway: vi.fn(async () => undefined),
      status: vi.fn(() => ({ activeSlot: { build: { commit: "old-sha" } } }))
    };
    let installAttempts = 0;
    const commands: string[] = [];
    const runner = vi.fn(async (command: string, args: string[], cwd: string) => {
      const commandLine = `${command} ${args.join(" ")}`;
      commands.push(`${cwd}:${commandLine}`);
      if (commandLine === "git rev-parse HEAD" || commandLine === "git rev-parse origin/main") return { stdout: "new-sha\n", stderr: "" };
      if (commandLine === "git branch --show-current") return { stdout: "main\n", stderr: "" };
      if (commandLine === "npm ci --include=dev" && installAttempts++ === 0) throw new Error("install failed");
      return { stdout: "", stderr: "" };
    });
    const updater = createSelfUpdater(config, logger, promotions, runner);

    await expect(updater.checkNow()).rejects.toThrow("install failed");
    await updater.checkNow();

    expect(commands.filter((command) => command.endsWith(":npm ci --include=dev"))).toHaveLength(2);
    expect(commands.filter((command) => command.includes("build --workspace @openoverlay/backend"))).toHaveLength(1);
    expect(commands.filter((command) => command.includes("test --workspace @openoverlay/backend"))).toHaveLength(1);
    expect(promotions.startCandidate).toHaveBeenCalledWith("new-sha");
    expect(promotions.promoteCandidate).toHaveBeenCalledOnce();
    expect(promotions.restartGateway).toHaveBeenCalledOnce();
  });

  it("refuses to promote when untracked or modified files appear during the build", async () => {
    const promotions = {
      canPromote: vi.fn(() => true),
      startCandidate: vi.fn(async () => ({ id: "candidate" })),
      promoteCandidate: vi.fn(),
      restartGateway: vi.fn(async () => undefined),
      status: vi.fn(() => ({ activeSlot: { build: { commit: "old-sha" } } }))
    };
    let statusChecks = 0;
    let head = "old-sha";
    const runner = vi.fn(async (command: string, args: string[]) => {
      const commandLine = `${command} ${args.join(" ")}`;
      if (commandLine === "git rev-parse HEAD") return { stdout: `${head}\n`, stderr: "" };
      if (commandLine === "git rev-parse origin/main") return { stdout: "new-sha\n", stderr: "" };
      if (commandLine === "git branch --show-current") return { stdout: "main\n", stderr: "" };
      if (commandLine === "git pull --ff-only origin main") head = "new-sha";
      if (commandLine === "git status --porcelain --untracked-files=normal") {
        statusChecks += 1;
        return { stdout: statusChecks === 1 ? "" : "?? unexpected.ts\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    const updater = createSelfUpdater(config, logger, promotions, runner);
    await expect(updater.checkNow()).rejects.toThrow(/changed during self-update build/);
    expect(promotions.startCandidate).not.toHaveBeenCalled();
    expect(promotions.restartGateway).not.toHaveBeenCalled();
  });
});
