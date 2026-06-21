# Eval Harness — Deliverable

## What shipped

A TypeScript HTTP service at `/workspace/packages/eval-harness` that:

1. Accepts agent submissions via REST (`POST /agents/submit`).
2. Sandboxes the agent's `strategy` function in a Node `vm` context with a
   1-second per-call timeout.
3. Runs the agent against a fixed evaluation dataset (BTCUSDT, ETHUSDT,
   SOLUSDT, 1h bars, 2024) using the bundled Python backtester.
4. Computes a **composite score** from the resulting metrics.
5. Exposes a leaderboard ranked by the composite (or any single metric).
6. Persists everything in SQLite (`data/eval.db`).

### Files created

```
src/
  server.ts                Fastify app factory + bootstrap (port 4000 default)
  routes/api.ts            POST /agents/submit, GET /agents, GET /agents/:id,
                           GET /leaderboard, GET /health
  sandbox/
    runner.ts              orchestrates the backtester subprocess
    runAgent.ts            vm sandbox + 1s per-call timeout
  score/composite.ts       compositeScore(metrics), rankAgents()
  db/store.ts              better-sqlite3 schema + queries
  examples/agents.ts       random, sma, momentum reference agents
  types.ts                 Metrics, Action, RunResult shared types
test/
  api.test.ts              HTTP integration (submit, list, get, leaderboard)
  composite.test.ts        score math (hand-checked fixture)
  runner.test.ts           end-to-end submit → run → leaderboard
  sandbox.test.ts          timeout, throws, captures failure
  store.test.ts            SQLite persistence
package.json
tsconfig.json
vitest.config.ts
README.md
```

### How to run

```bash
cd /workspace/packages/eval-harness
npm install
npm test            # all suites pass
npm start           # listens on :4000
```

### API reference

#### `GET /health`

```json
{ "ok": true, "time": "2024-01-01T00:00:00.000Z" }
```

#### `POST /agents/submit`

```json
// request
{
  "name": "sma-cross-v1",
  "author": "you",
  "code": "export function strategy(marketData, portfolio) { return { side: 'hold' }; }"
}

// response
{
  "agent": { "id": 1, "name": "sma-cross-v1", "author": "you", "created_at": "..." },
  "run":   { "id": 1, "status": "ok", "metrics": { ... }, "score": 1.42 }
}
```

#### `GET /agents`

List all submissions (latest first).

#### `GET /agents/:id`

Single agent + all runs.

#### `GET /leaderboard?metric=composite&limit=100`

Sorted descending. `metric` ∈ `composite | sharpe | sortino | calmar |
profit_factor | max_drawdown | total_return | n_trades`.

### Composite score

```text
composite = 0.40 * sharpe
          + 0.20 * sortino
          + 0.20 * calmar
          + 0.10 * profit_factor
          + 0.10 * max(0, min(1, 1 + max_drawdown))
```

- `sharpe` is annualized risk-adjusted return (40% — the headline number).
- `sortino` is downside-only vol (20% — penalizes whipsaw strategies less).
- `calmar` is return / max drawdown (20% — the "did you blow up" check).
- `profit_factor` is gross wins / gross losses (10% — absolute edge).
- `drawdown` term is clamped to `[0, 1]` of `(1 + max_drawdown)`, so a
  broken backtest returning `-99.9` DD can't tank the leaderboard.

### Design decisions

- **Sandbox is `node:vm`**, not a separate process — faster startup, easier
  per-call timeout, sufficient for non-malicious competition code. For an
  untrusted public deployment you'd swap in `isolated-vm` or a real container.
- **Per-call timeout is 1 second.** Generous enough for any reasonable
  indicator math; tight enough to prevent runaway `while(true)`.
- **Failures are recorded, not crashed.** Every thrown error is caught,
  the run is marked `failed`, the agent is hidden from the leaderboard.
  The author can fix + resubmit and the new run replaces the old.
- **SQLite via `better-sqlite3`.** Synchronous, single-file, zero ops.
  Production-grade for a leaderboard of thousands of agents; swap for
  Postgres if you ever need a million-agent leaderboard.
- **No leverage / no live trading in the harness.** The harness only
  scores; live trading is a separate concern (and a separate service).

### Test summary

All vitest suites pass. 5 test files. The sandbox test covers the
adversarial cases the spec called out:
- Agent that throws on every call → run marked failed, leaderboard
  excludes the agent.
- Agent that calls `while(true){}` → killed at 1s timeout.
- Hand-computed composite score from a known metrics fixture matches
  the harness's output.
- Invalid POST payloads (missing fields, wrong types, oversized code) →
  400 with zod issue list.

### Integration

The harness spawns the Python backtester at `packages/backtester` as a
subprocess and reads the JSON metrics it emits. The backtester package
also supports a `python3 -m backtester run` form. For the bundled
evaluation dataset the harness uses precomputed synthetic CSV fixtures
under `packages/backtester/fixtures/`, so the demo runs **without
network access**.
