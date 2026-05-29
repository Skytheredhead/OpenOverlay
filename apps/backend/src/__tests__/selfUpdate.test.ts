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
  gatewaySlotStartupTimeoutMs: 15_000
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
  it("pulls, rebuilds, and queues a restart when origin/main changes", async () => {
    vi.useFakeTimers();
    const restart = vi.fn();
    const promotions = {
      canPromote: vi.fn(() => true),
      startCandidate: vi.fn(async () => ({ id: "candidate" })),
      promoteCandidate: vi.fn(),
      status: vi.fn(() => ({ activeSlot: { id: "active" } }))
    };
    const commands: string[] = [];
    const runner = vi.fn(async (command: string, args: string[], cwd: string) => {
      commands.push(`${cwd}:${command} ${args.join(" ")}`);
      const commandLine = `${command} ${args.join(" ")}`;
      if (commandLine === "git rev-parse HEAD") return { stdout: "old-sha\n", stderr: "" };
      if (commandLine === "git rev-parse origin/main") return { stdout: "new-sha\n", stderr: "" };
      if (commandLine === "git branch --show-current") return { stdout: "main\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });

    const updater = createSelfUpdater(config, logger, promotions, runner);

    await updater.checkNow();
    vi.advanceTimersByTime(500);

    expect(commands).toEqual([
      "/srv/openoverlay:git fetch --quiet origin main",
      "/srv/openoverlay:git rev-parse HEAD",
      "/srv/openoverlay:git rev-parse origin/main",
      "/srv/openoverlay:git branch --show-current",
      "/srv/openoverlay:git diff --quiet",
      "/srv/openoverlay:git diff --cached --quiet",
      "/srv/openoverlay:git pull --ff-only origin main",
      "/srv/openoverlay:npm ci",
      "/srv/openoverlay:npm run build --workspace @openoverlay/shared",
      "/srv/openoverlay:npm run build --workspace @openoverlay/backend"
    ]);
    expect(restart).not.toHaveBeenCalled();
    expect(promotions.startCandidate).toHaveBeenCalledTimes(1);
    expect(promotions.promoteCandidate).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("self_update_applied", { previousCommit: "old-sha", currentCommit: "new-sha", candidate: { id: "candidate" } });

    vi.useRealTimers();
  });
});
