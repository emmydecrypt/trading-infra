import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Mock the runner so API tests don't spawn Python (~26s/agent).
// We exercise the real runner in test/runner.test.ts.
vi.mock("../src/sandbox/runner.js", () => ({
  runAgentAgainstDatasets: vi.fn(async (_code: string) => ({
    ok: true,
    metrics: {
      sharpe: 1.2,
      sortino: 1.5,
      calmar: 0.8,
      profit_factor: 1.4,
      max_drawdown: -0.1,
      total_return: 0.2,
      n_trades: 12,
    },
    error: null,
    started_at: "2024-06-01T00:00:00Z",
    finished_at: "2024-06-01T00:00:10Z",
    duration_ms: 10,
  })),
  DEFAULT_DATASETS: [
    { symbol: "BTCUSDT", start: "2024-01-01T00:00:00Z", end: "2024-12-31T23:00:00Z", interval: "1h" as const },
    { symbol: "ETHUSDT", start: "2024-01-01T00:00:00Z", end: "2024-12-31T23:00:00Z", interval: "1h" as const },
    { symbol: "SOLUSDT", start: "2024-01-01T00:00:00Z", end: "2024-12-31T23:00:00Z", interval: "1h" as const },
  ],
}));

import { buildApp } from "../src/server.js";
import { SMA_CROSS_AGENT, RANDOM_AGENT } from "../src/examples/agents.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Clean DB between tests by closing and reopening.
  await app.close();
  app = await buildApp({ dbPath: ":memory:", logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
});

async function post(path: string, body: unknown) {
  return app.inject({ method: "POST", url: path, payload: body as object });
}

async function get(path: string) {
  return app.inject({ method: "GET", url: path });
}

describe("HTTP API", () => {
  it("GET /health returns ok", async () => {
    const res = await get("/health");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
  });

  it("POST /agents/submit stores an agent and runs it", async () => {
    const res = await post("/agents/submit", {
      name: "sma-cross-1",
      author: "tester",
      code: SMA_CROSS_AGENT,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.agent.name).toBe("sma-cross-1");
    expect(typeof body.agent.id).toBe("number");
    expect(body.result).toBeTruthy();
    // The metrics block may be null if the runner is missing the backtester,
    // but composite_score should still be a number on success.
    if (body.result.ok) {
      expect(body.result.metrics).toBeTruthy();
      expect(typeof body.composite_score).toBe("number");
    }
  });

  it("GET /agents lists submitted agents", async () => {
    await post("/agents/submit", { name: "a1", author: "x", code: SMA_CROSS_AGENT });
    await post("/agents/submit", { name: "a2", author: "x", code: RANDOM_AGENT });
    const res = await get("/agents");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents.length).toBe(2);
    const names = body.agents.map((a: { name: string }) => a.name).sort();
    expect(names).toEqual(["a1", "a2"]);
  });

  it("GET /agents/:id returns details for an existing agent and 404 for missing", async () => {
    const submit = await post("/agents/submit", { name: "lonely", author: "x", code: SMA_CROSS_AGENT });
    const id = submit.json().agent.id;
    const res = await get(`/agents/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    const missing = await get("/agents/99999");
    expect(missing.statusCode).toBe(404);
  });

  it("GET /leaderboard sorts by composite (or requested metric) descending", async () => {
    await post("/agents/submit", { name: "p1", author: "x", code: SMA_CROSS_AGENT });
    await post("/agents/submit", { name: "p2", author: "x", code: RANDOM_AGENT });
    const res = await get("/leaderboard");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metric).toBe("composite");
    expect(Array.isArray(body.entries)).toBe(true);
    const scores = body.entries
      .map((e: { composite_score: number | null }) => e.composite_score)
      .filter((s: number | null): s is number => typeof s === "number");
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it("POST /agents/submit rejects bad payloads with zod issues", async () => {
    const res = await post("/agents/submit", { name: "", author: "x", code: "" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("validation_failed");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("GET /leaderboard?metric=sharpe sorts by sharpe", async () => {
    await post("/agents/submit", { name: "p1", author: "x", code: SMA_CROSS_AGENT });
    await post("/agents/submit", { name: "p2", author: "x", code: RANDOM_AGENT });
    const res = await get("/leaderboard?metric=sharpe");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metric).toBe("sharpe");
    const sharpes = body.entries
      .map((e: { metrics: { sharpe: number } | null }) => e.metrics?.sharpe)
      .filter((s: number | undefined): s is number => typeof s === "number");
    for (let i = 1; i < sharpes.length; i++) {
      expect(sharpes[i - 1]).toBeGreaterThanOrEqual(sharpes[i]);
    }
  });

  it("GET /leaderboard?metric=bogus is rejected by zod", async () => {
    const res = await get("/leaderboard?metric=bogus");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_failed");
  });
});