import fs from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createLogger(logFile: string): Logger {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const write = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {})
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (level === "error") console.error(line.trim());
    else if (level === "warn") console.warn(line.trim());
    else console.log(line.trim());
    fs.appendFile(logFile, line, () => undefined);
  };

  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta)
  };
}
