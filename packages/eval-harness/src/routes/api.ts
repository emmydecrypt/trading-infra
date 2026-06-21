import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Store } from "../db/store.js";
import { runAgentAgainstDatasets } from "../sandbox/runner.js";
import { compositeScore, rankAgents } from "../score/composite.js";
import type { Metrics, RunResult } from "../types.js";
import { EXAMPLES } from "../examples/agents.js";

const SubmitSchema = z.object({
  name: z.string().min(1).max(64),
  code: z.string().min(1).max(20_000),
  author: z.string().min(1).max(64),
});

const LeaderboardQuery = z.object({
  metric: z
    .enum([
      "composite",
      "sharpe",
      "sortino",
      "calmar",
      "profit_factor",
      "max_drawdown",
      "total_return",
      "n_trades",
    ])
    .optional()
    .default("composite"),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

export interface RouteDeps {
  store: Store;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store } = deps;

  app.get("/health", async () => ({ ok: true, time: new Date().toISOString() }));

  app.post("/agents/submit", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = SubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_failed", issues: parsed.error.issues });
    }
    const { name, code, author } = parsed.data;
    const agent = store.insertAgent({ name, code, author });
    let result: RunResult;
    try {
      result = await runAgentAgainstDatasets(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const now = new Date().toISOString();
      result = {
        ok: false,
        metrics: null,
        error: `runner threw: ${message}`,
        started_at: now,
        finished_at: now,
        duration_ms: 0,
      };
    }
    const run = store.insertRun({
      agent_id: agent.id,
      started_at: result.started_at,
      finished_at: result.finished_at,
      metrics_json: JSON.stringify(result),
    });
    return reply.code(201).send({
      agent,
      run_id: run.id,
      result,
      composite_score: result.metrics ? compositeScore(result.metrics) : null,
    });
  });

  app.get("/agents", async () => {
    const agents = store.listAgents();
    return {
      agents: agents.map((a) => {
        const run = store.latestRun(a.id);
        const result = run ? (JSON.parse(run.metrics_json) as RunResult) : null;
        return {
          id: a.id,
          name: a.name,
          author: a.author,
          created_at: a.created_at,
          metrics: result?.metrics ?? null,
          composite_score: result?.metrics ? compositeScore(result.metrics) : null,
          ok: result?.ok ?? false,
          error: result?.error ?? null,
        };
      }),
    };
  });

  app.get("/agents/:id", async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: "invalid id" });
    const agent = store.getAgent(id);
    if (!agent) return reply.code(404).send({ error: "not_found" });
    const run = store.latestRun(id);
    const result = run ? (JSON.parse(run.metrics_json) as RunResult) : null;
    return {
      id: agent.id,
      name: agent.name,
      author: agent.author,
      created_at: agent.created_at,
      metrics: result?.metrics ?? null,
      composite_score: result?.metrics ? compositeScore(result.metrics) : null,
      ok: result?.ok ?? false,
      error: result?.error ?? null,
      started_at: result?.started_at ?? null,
      finished_at: result?.finished_at ?? null,
      duration_ms: result?.duration_ms ?? null,
    };
  });

  app.get("/leaderboard", async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = LeaderboardQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_failed", issues: parsed.error.issues });
    }
    const { metric, limit } = parsed.data;
    const agents = store.listAgents();
    const entries = agents.map((a) => {
      const run = store.latestRun(a.id);
      const result = run ? (JSON.parse(run.metrics_json) as RunResult) : null;
      const metrics = (result?.metrics ?? null) as Metrics | null;
      return {
        id: a.id,
        name: a.name,
        author: a.author,
        ok: result?.ok ?? false,
        metrics,
        composite_score: metrics ? compositeScore(metrics) : null,
        error: result?.error ?? null,
      };
    });
    const ranked = rankAgents(entries, metric).slice(0, limit);
    return {
      metric,
      count: ranked.length,
      entries: ranked.map((e, i) => ({ rank: i + 1, ...e })),
    };
  });

  // Convenience: list the shipped example agents so users can grab one
  // and submit it back. Not part of the strict API contract but cheap.
  app.get("/examples", async () => {
    return {
      examples: Object.entries(EXAMPLES).map(([key, code]) => ({ name: key, code })),
    };
  });
}