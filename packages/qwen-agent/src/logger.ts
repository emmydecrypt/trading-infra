/**
 * Tiny file + stderr JSON logger. One JSON object per line, UTC timestamp.
 * No external deps. Suitable for both tests (stderr only) and the CLI
 * (writes to logs/agent.log).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentLogger } from "./agent.js";

export interface FileLoggerOptions {
  filePath?: string; // if set, also write to this file
  /** Include debug entries on stderr too. */
  echo?: boolean;
}

export class FileLogger implements AgentLogger {
  private readonly filePath?: string;
  private readonly echo: boolean;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: FileLoggerOptions = {}) {
    this.filePath = opts.filePath;
    this.echo = opts.echo ?? false;
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.write("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.write("error", msg, meta);
  }

  /** Resolve any pending writes (useful before process exit). */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private write(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
    if (this.echo) {
      const stream = level === "error" ? process.stderr : process.stdout;
      stream.write(line + "\n");
    }
    if (this.filePath) {
      this.writeChain = this.writeChain
        .catch(() => undefined)
        .then(async () => {
          await fs.mkdir(path.dirname(this.filePath!), { recursive: true });
          await fs.appendFile(this.filePath!, line + "\n", "utf8");
        });
    }
  }
}

/** In-memory logger for tests. */
export class MemoryLogger implements AgentLogger {
  readonly entries: Array<{ level: "info" | "warn" | "error"; msg: string; meta?: Record<string, unknown> }> = [];
  info(msg: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: "info", msg, meta });
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: "warn", msg, meta });
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.entries.push({ level: "error", msg, meta });
  }
}
