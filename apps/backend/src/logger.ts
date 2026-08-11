import fs from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  flush?(): Promise<void>;
}

interface LoggerOptions {
  maxBytes?: number;
  retainedFiles?: number;
  maxPendingWrites?: number;
}

export function createLogger(logFile: string, options: LoggerOptions = {}): Logger {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const retainedFiles = options.retainedFiles ?? 3;
  const maxPendingWrites = options.maxPendingWrites ?? 512;
  let fileBytes = safeFileSize(logFile);
  let pendingWrites = 0;
  let rotationRequested = false;
  let droppedLines = 0;
  let diskWritable = true;
  const flushWaiters: Array<() => void> = [];

  const write = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {})
    };
    const line = boundedJsonLine(entry);
    if (level === "error") console.error(line.trim());
    else if (level === "warn") console.warn(line.trim());
    else console.log(line.trim());
    if (!diskWritable || rotationRequested || pendingWrites >= maxPendingWrites) {
      droppedLines += 1;
      return;
    }

    let queuedLine = line;
    if (droppedLines > 0) {
      queuedLine = `${boundedJsonLine({
        ts: new Date().toISOString(),
        level: "warn",
        message: "log_lines_dropped",
        meta: { count: droppedLines }
      })}${queuedLine}`;
      droppedLines = 0;
    }
    const bytes = Buffer.byteLength(queuedLine);
    if (fileBytes + bytes > maxBytes) {
      if (pendingWrites === 0) rotateFiles();
      else {
        rotationRequested = true;
        droppedLines += 1;
        return;
      }
    }

    pendingWrites += 1;
    fileBytes += bytes;
    fs.appendFile(logFile, queuedLine, { mode: 0o640 }, (error) => {
      pendingWrites = Math.max(0, pendingWrites - 1);
      if (error) {
        diskWritable = false;
        console.error(`OpenOverlay file logging disabled: ${error.message}`);
      }
      if (pendingWrites === 0 && rotationRequested) {
        rotationRequested = false;
        rotateFiles();
      }
      resolveFlushWaiters();
    });
  };

  function rotateFiles() {
    try {
      if (retainedFiles > 0) {
        for (let index = retainedFiles - 1; index >= 1; index -= 1) {
          const source = `${logFile}.${index}`;
          const destination = `${logFile}.${index + 1}`;
          if (!fs.existsSync(source)) continue;
          fs.rmSync(destination, { force: true });
          fs.renameSync(source, destination);
        }
        if (fs.existsSync(logFile)) {
          fs.rmSync(`${logFile}.1`, { force: true });
          fs.renameSync(logFile, `${logFile}.1`);
        }
      } else if (fs.existsSync(logFile)) {
        fs.truncateSync(logFile, 0);
      }
      fileBytes = 0;
    } catch (error) {
      diskWritable = false;
      console.error(`OpenOverlay log rotation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function resolveFlushWaiters() {
    if (pendingWrites !== 0 || rotationRequested) return;
    for (const resolve of flushWaiters.splice(0)) resolve();
  }

  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
    flush: () => pendingWrites === 0 && !rotationRequested
      ? Promise.resolve()
      : new Promise<void>((resolve) => flushWaiters.push(resolve))
  };
}

function safeFileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function boundedJsonLine(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = JSON.stringify({ ts: new Date().toISOString(), level: "error", message: "log_serialization_failed" });
  }
  const maxLineBytes = 64 * 1024;
  if (Buffer.byteLength(serialized) <= maxLineBytes) return `${serialized}\n`;
  return `${JSON.stringify({
    ts: new Date().toISOString(),
    level: "warn",
    message: "log_entry_truncated",
    meta: { originalBytes: Buffer.byteLength(serialized) }
  })}\n`;
}
