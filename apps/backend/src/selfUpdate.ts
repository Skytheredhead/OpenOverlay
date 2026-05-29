import { execFile } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

export interface SelfUpdater {
  start(): void;
  stop(): void;
  checkNow(): Promise<void>;
}

export interface PromotionController {
  canPromote(): boolean;
  startCandidate(): Promise<unknown>;
  promoteCandidate(): void;
  status(): unknown;
}

export function createSelfUpdater(config: AppConfig, logger: Logger, promotions: PromotionController, runner: CommandRunner = runCommand): SelfUpdater {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running = false;

  const schedule = (delayMs: number) => {
    if (stopped || !config.selfUpdateEnabled) return;
    timer = setTimeout(() => void tick(), delayMs);
    timer.unref();
  };

  const tick = async () => {
    if (running) {
      schedule(config.selfUpdateIntervalMs);
      return;
    }

    running = true;
    try {
      await checkNow();
    } catch (error) {
      logger.error("self_update_failed", errorMeta(error));
    } finally {
      running = false;
      schedule(config.selfUpdateIntervalMs);
    }
  };

  const checkNow = async () => {
    if (!config.selfUpdateEnabled) return;
    if (!promotions.canPromote()) {
      logger.info("self_update_skipped_gateway_busy", { gateway: promotions.status() as Record<string, unknown> });
      return;
    }

    const repoDir = config.selfUpdateRepoDir;
    await runner("git", ["fetch", "--quiet", config.selfUpdateRemote, config.selfUpdateBranch], repoDir);

    let localCommit = (await runner("git", ["rev-parse", "HEAD"], repoDir)).stdout.trim();
    const remoteCommit = (await runner("git", ["rev-parse", `${config.selfUpdateRemote}/${config.selfUpdateBranch}`], repoDir)).stdout.trim();
    if (!localCommit || !remoteCommit) return;

    const activeCommit = activeSlotCommit(promotions.status());
    const previousCommit = activeCommit || localCommit;
    if (localCommit === remoteCommit && activeCommit === remoteCommit) return;

    if (localCommit !== remoteCommit) {
      const branch = (await runner("git", ["branch", "--show-current"], repoDir)).stdout.trim();
      if (branch !== config.selfUpdateBranch) {
        logger.warn("self_update_skipped_wrong_branch", { branch, expectedBranch: config.selfUpdateBranch, localCommit, remoteCommit });
        return;
      }

      if (!(await isCleanWorkingTree(runner, repoDir))) {
        logger.warn("self_update_skipped_dirty_worktree", { repoDir, localCommit, remoteCommit });
        return;
      }

      logger.info("self_update_detected", { localCommit, remoteCommit, branch: config.selfUpdateBranch });
      await runner("git", ["pull", "--ff-only", config.selfUpdateRemote, config.selfUpdateBranch], repoDir);
      await runner("npm", ["ci"], repoDir);
      await runner("npm", ["run", "build", "--workspace", "@openoverlay/shared"], repoDir);
      await runner("npm", ["run", "build", "--workspace", "@openoverlay/backend"], repoDir);
      localCommit = remoteCommit;
    } else {
      logger.info("self_update_retrying_unpromoted_commit", { activeCommit, targetCommit: remoteCommit });
    }

    const candidate = await promotions.startCandidate();
    promotions.promoteCandidate();
    logger.info("self_update_applied", { previousCommit, currentCommit: remoteCommit, candidate });
  };

  return {
    start() {
      if (!config.selfUpdateEnabled) return;
      stopped = false;
      logger.info("self_update_started", {
        repoDir: config.selfUpdateRepoDir,
        remote: config.selfUpdateRemote,
        branch: config.selfUpdateBranch,
        intervalMs: config.selfUpdateIntervalMs
      });
      schedule(config.selfUpdateIntervalMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    checkNow
  };
}

async function isCleanWorkingTree(runner: CommandRunner, repoDir: string): Promise<boolean> {
  try {
    await runner("git", ["diff", "--quiet"], repoDir);
    await runner("git", ["diff", "--cached", "--quiet"], repoDir);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 5 * 60_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr, command, args }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function errorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      stdout: (error as Error & { stdout?: string }).stdout,
      stderr: (error as Error & { stderr?: string }).stderr,
      command: (error as Error & { command?: string }).command,
      args: (error as Error & { args?: string[] }).args
    };
  }

  return { error };
}

function activeSlotCommit(status: unknown): string | null {
  if (!isRecord(status)) return null;
  const activeSlot = status.activeSlot;
  if (!isRecord(activeSlot)) return null;
  const build = activeSlot.build;
  if (!isRecord(build)) return null;
  return typeof build.commit === "string" && build.commit ? build.commit : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
