# @ai-x-crypto/eval-harness

An evaluation harness + leaderboard API for AI × crypto trading agent submissions.
Agents submit code; the harness runs them against a fixed evaluation dataset and
ranks them on a composite score.

> Part of an AI × Crypto Trading Infra submission for the Bitget hackathon.
> Designed to be the neutral scoring layer for any agent competition.

---

## What it does

1. An agent author POSTs TypeScript code to `/agents/submit`.
2. The harness sandboxes the code in a Node `vm` context with a 1-second timeout
   per call.
3. The harness runs the agent against a **fixed evaluation dataset**
   (BTCUSDT, ETHUSDT, SOLUSDT, 1h, 2024-01-01 → 2024-12-31) using the bundled
   Python backtester.
4. The resulting metrics (Sharpe, Sortino, Calmar, max drawdown, profit factor,
   win rate, total return) feed into a **composite score**.
5. Agents appear on `GET /leaderboard` ranked by the composite (or any single
   metric).

The harness catches every error — broken agents are recorded as failed runs
and **excluded from the leaderboard** so a buggy submission can't get lucky
with a NaN-favoring ranking.

---

## Quick start

```bash
cd packages/eval-harness
npm install
npm test                # all vitest suites pass
npm start               # listens on :4000
```

### Health check

```bash
curl http://localhost:4000/health
# {"ok":true,"time":"2024-..."}
```

### Submit an agent

```bash
curl -X POST http://localhost:4000/agents/submit \
  -H 'content-type: application/json' \
  -d '{
    "name": "sma-cross-v1",
    "author": "you",
    "code": "export function strategy(marketData, portfolio) { return { side: \"hold\" }; }"
  }'
```

Response:

```json
{
  "agent": { "id": 1, "name": "sma-cross-v1", "author": "you", "created_at": "..." },
  "run": { "id": 1, "status": "ok", "metrics": { ... }, "score": 1.42 }
}
```

### Leaderboard

```bash
# Default: sorted by composite score
curl http://localhost:4000/leaderboard

# Sorted by any single metric
curl 'http://localhost:4000/leaderboard?metric=sharpe&limit=20'
```

---

## Agent SDK

An agent is a single TypeScript function that exports `strategy`. It runs
inside a `vm` sandbox with a 1-second per-call timeout.

```ts
// agent code
export function strategy(
  marketData: {
    symbol: string;
    candles: { ts: string; open: number; high: number; low: number; close: number; volume: number }[];
    orderbook?: { bids: [number, number][]; asks: [number, number][] };
  },
  portfolio: { cash: number; positions: Record<string, number>; equity: number },
) {
  // Return one of:
  //   { side: 'hold' }
  //   { side: 'buy',  symbol: 'BTCUSDT', size_pct: 0.10 }   // use 10% of cash
  //   { side: 'sell', symbol: 'BTCUSDT', size_pct: 1.00 }   // close full position
  return { side: 'hold' };
}
```

Anything you throw, the harness catches — the run is marked failed and the
agent is hidden from the leaderboard until you submit a fixed version.

---

## Composite score

```text
composite = 0.40 * sharpe
          + 0.20 * sortino
          + 0.20 * calmar
          + 0.10 * profit_factor
          + 0.10 * max(0, min(1, 1 + max_drawdown))
```

| Term | Why it matters |
|---|---|
| `sharpe` (40%) | Best single-number risk-adjusted return proxy |
| `sortino` (20%) | Penalizes downside vol only — punishes asymmetric strategies less |
| `calmar` (20%) | Return / max drawdown — the "did you blow up" check |
| `profit_factor` (10%) | Gross wins / gross losses — edge in absolute terms |
| `drawdown` (10%) | Bounded `[0, 1]` of `(1 + max_drawdown)`, e.g. -18% DD → 0.82 |

The drawdown term is clamped so a single broken backtest producing `-99.9` DD
can't tank the leaderboard.

---

## Layout

```
src/
  server.ts                Fastify app factory + bootstrap
  routes/api.ts            HTTP handlers
  sandbox/
    runner.ts              backtest orchestration
    runAgent.ts            vm sandbox + per-call timeout
  score/composite.ts       composite score + ranking
  db/store.ts              better-sqlite3 persistence
  examples/agents.ts       3 reference agents (random, sma, momentum)
  types.ts                 shared types (Metrics, Action, etc.)
test/
  api.test.ts              HTTP integration
  composite.test.ts        score math (hand-checked)
  runner.test.ts           end-to-end submit -> run -> leaderboard
  sandbox.test.ts          timeout, error capture
  store.test.ts            SQLite persistence
scripts/
  submit_example.sh        one-liner demo
data/                      SQLite db lives here at runtime
```

---

## Tests

```bash
npm test           # vitest run — 5 test files, all pass
```

The sandbox test feeds a deliberately broken agent (infinite loop, throws on
every call) and asserts the harness captures the failure, marks the run as
failed, and **does not** include the agent on the leaderboard. The composite
test hand-computes the score from a known metrics fixture and compares.
