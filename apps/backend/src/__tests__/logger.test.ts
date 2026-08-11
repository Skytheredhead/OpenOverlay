import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("logger", () => {
  it("bounds file growth with rotation and survives circular metadata", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-logger-"));
    temporaryDirectories.push(directory);
    const logFile = path.join(directory, "backend.log");
    const logger = createLogger(logFile, { maxBytes: 420, retainedFiles: 2, maxPendingWrites: 64 });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    logger.error("circular", circular);
    await logger.flush?.();
    for (let index = 0; index < 12; index += 1) {
      logger.info(`entry-${index}`, { payload: "x".repeat(100) });
      await logger.flush?.();
    }

    expect(fs.existsSync(logFile)).toBe(true);
    expect(fs.existsSync(`${logFile}.1`)).toBe(true);
    expect(fs.existsSync(`${logFile}.3`)).toBe(false);
    expect(fs.statSync(logFile).size).toBeLessThanOrEqual(420);
    expect(fs.statSync(`${logFile}.1`).size).toBeLessThanOrEqual(420);
  });

  it("drops excess queued writes instead of allowing an unbounded backlog", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openoverlay-logger-"));
    temporaryDirectories.push(directory);
    const logFile = path.join(directory, "backend.log");
    const logger = createLogger(logFile, { maxBytes: 10_000, retainedFiles: 1, maxPendingWrites: 1 });

    for (let index = 0; index < 20; index += 1) logger.info(`burst-${index}`);
    await logger.flush?.();
    logger.info("after-burst");
    await logger.flush?.();

    const contents = fs.readFileSync(logFile, "utf8");
    expect(contents).toContain("log_lines_dropped");
    expect(contents).toContain("after-burst");
    expect(contents.split("\n").filter(Boolean).length).toBeLessThan(20);
  });
});
