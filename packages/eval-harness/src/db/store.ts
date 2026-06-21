import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

export interface AgentRow {
  id: number;
  name: string;
  code: string;
  author: string;
  created_at: string;
}

export interface RunRow {
  id: number;
  agent_id: number;
  started_at: string;
  finished_at: string | null;
  metrics_json: string;
}

export class Store {
  private db: Database.Database;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        metrics_json TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id);
    `);
  }

  insertAgent(input: { name: string; code: string; author: string }): AgentRow {
    const stmt = this.db.prepare(
      "INSERT INTO agents (name, code, author, created_at) VALUES (?, ?, ?, ?)",
    );
    const created_at = new Date().toISOString();
    const info = stmt.run(input.name, input.code, input.author, created_at);
    return { id: Number(info.lastInsertRowid), ...input, created_at };
  }

  listAgents(): AgentRow[] {
    return this.db
      .prepare("SELECT id, name, code, author, created_at FROM agents ORDER BY id DESC")
      .all() as AgentRow[];
  }

  getAgent(id: number): AgentRow | undefined {
    return this.db
      .prepare("SELECT id, name, code, author, created_at FROM agents WHERE id = ?")
      .get(id) as AgentRow | undefined;
  }

  insertRun(input: {
    agent_id: number;
    started_at: string;
    finished_at: string;
    metrics_json: string;
  }): RunRow {
    const stmt = this.db.prepare(
      "INSERT INTO runs (agent_id, started_at, finished_at, metrics_json) VALUES (?, ?, ?, ?)",
    );
    const info = stmt.run(
      input.agent_id,
      input.started_at,
      input.finished_at,
      input.metrics_json,
    );
    return {
      id: Number(info.lastInsertRowid),
      agent_id: input.agent_id,
      started_at: input.started_at,
      finished_at: input.finished_at,
      metrics_json: input.metrics_json,
    };
  }

  latestRun(agent_id: number): RunRow | undefined {
    return this.db
      .prepare(
        "SELECT id, agent_id, started_at, finished_at, metrics_json FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(agent_id) as RunRow | undefined;
  }

  allRuns(): RunRow[] {
    return this.db
      .prepare("SELECT id, agent_id, started_at, finished_at, metrics_json FROM runs")
      .all() as RunRow[];
  }

  close(): void {
    this.db.close();
  }
}