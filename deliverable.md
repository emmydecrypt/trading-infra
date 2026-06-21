# Trading Infra — Final Deliverable

## What this is

A complete, tested, demoable AI × Crypto trading infrastructure stack.
Built for the Bitget hackathon, **Trading Infra** track.

**One zip. 229 KB. Clone, install, run.**

## TL;DR for the user

```bash
# 1. Unzip
unzip trading-infra.zip
cd workspace

# 2. Install Node deps (monorepo via npm workspaces)
npm install

# 3. Install Python deps (the backtester)
cd packages/backtester && uv sync --extra dev && cd ../..

# 4. Configure (add Qwen key)
cp .env.example .env
# Edit .env, set QWEN_API_KEY=...

# 5. Run the full test suite — 143 tests
npm run test:all

# 6. Run the demo
npm run demo
```

Or with Docker:

```bash
docker compose up --build
# eval-harness listens on http://localhost:4000
```

## File tree

```
workspace/
├── README.md                  ← judges read this first
├── LICENSE                    ← MIT
├── package.json               ← npm workspaces root
├── docker-compose.yml         ← one-command bring-up
├── .env.example               ← env var template
├── .gitignore
├── demo/
│   ├── demo.sh                ← reproducible end-to-end demo
│   └── demo-output.txt        ← captured output (proves it works)
├── docs/
│   └── ARCHITECTURE.md        ← deep dive
├── packages/
│   ├── mcp-server/            ← Bitget + signal + Solana on-chain
│   │   ├── src/  (8 files, server.ts, bitget-client.ts, indicators.ts, ...)
│   │   ├── tests/  (5 files, 31 tests)
│   │   ├── examples/client.ts
│   │   ├── README.md
│   │   ├── deliverable.md
│   │   ├── Dockerfile
│   │   └── package.json
│   ├── backtester/            ← realistic execution sim
│   │   ├── src/backtester/  (10 .py files, engine/execution/metrics/portfolio/...)
│   │   ├── tests/  (4 files, 46 tests)
│   │   ├── fixtures/btcusdt_1h_synth.csv
│   │   ├── pyproject.toml
│   │   ├── README.md
│   │   └── deliverable.md
│   ├── eval-harness/          ← leaderboard + sandbox + scoring
│   │   ├── src/  (8 files, server.ts, routes/api.ts, sandbox/*, score/*)
│   │   ├── test/  (5 files, 29 tests)
│   │   ├── backtester/backtester.py  (bridge to Python)
│   │   ├── README.md
│   │   ├── deliverable.md
│   │   ├── Dockerfile
│   │   └── package.json
│   └── qwen-agent/            ← reference end-to-end agent
│       ├── src/  (9 files, agent.ts, qwen.ts, mcp-client.ts, ...)
│       ├── tests/  (7 files, 37 tests)
│       ├── examples/
│       ├── README.md
│       ├── deliverable.md
│       ├── Dockerfile
│       └── package.json
```

## Test summary

| Suite | Tests | Status |
|---|---|---|
| `packages/mcp-server` (vitest) | 31 | ✅ all pass |
| `packages/eval-harness` (vitest) | 29 | ✅ all pass |
| `packages/qwen-agent` (vitest) | 37 | ✅ all pass |
| `packages/backtester` (pytest) | 46 | ✅ all pass |
| **Total** | **143** | **✅** |

Test coverage spans:
- Bitget client (retry, rate limit, cache TTL)
- Indicator math (RSI, EMA, MACD) with hand-computed references
- Sandbox timeout, infinite-loop kill, error capture
- Composite score formula with adversarial hand-checks
- Realistic execution: slippage math, fees, latency, stop-loss, take-profit
- Sharpe with constant returns (no divide-by-near-zero)
- MCP server end-to-end with mocked Bitget fetch
- Qwen agent loop with mocked LLM + mocked MCP

## What the demo proves

The captured `demo/demo-output.txt` shows:

1. **MCP server tools** are documented and discoverable.
2. **Two reference agents** (SMA crossover, random baseline) are submitted
   to the eval-harness via HTTP `POST /agents/submit`.
3. The harness runs them through a backtest on 3 symbols × 1 year ×
   8760 hourly bars.
4. The leaderboard ranks them on the composite score.
5. The top agent's full metrics (Sharpe, Sortino, Calmar, max DD,
   profit factor, win rate, total return) are returned.

Sample from the captured run:

```
random-baseline  ok=true  sharpe=1.337  sortino=1.027  calmar=2.491
                 max_dd=-0.247  total_return=0.412  score=1.455
sma-cross-v1     ok=true  (no trades on synthetic prices)  score=0.100
```

## Sponsor-tech fit

| Sponsor | Where it's used |
|---|---|
| **Bitget** | `packages/mcp-server/src/bitget-client.ts` — public v2 REST API, no auth needed for read endpoints |
| **Qwen** | `packages/qwen-agent/src/qwen.ts` — OpenAI-compatible fetch to DashScope, function-calling for tool use |
| **Solana Foundation** | `packages/mcp-server/src/solana.ts` — `@solana/web3.js` + `@solana/spl-token` for on-chain reads |
| **MCP** (open standard) | Every package uses it — the lingua franca for agent tool calls |
| **Foresight Ventures / Foresight News / Dune** | (Not directly integrated — judges can extend) |

## Honest limitations (from each package's deliverable.md)

- **Public Bitget API** — no auth on read endpoints, but no private
  (account/orders) coverage in v1.
- **Public Solana RPC** — rate-limited under load; users should point
  at a paid endpoint via `SOLANA_RPC_URL`.
- **Single-symbol portfolio per backtest run** — multi-symbol
  portfolio backtests with rebalancing are v2.
- **No market-impact model** — slippage is flat bps, not
  `~sqrt(size/ADV)`.
- **Sandbox is `node:vm`** — sufficient for competition, not for
  untrusted public input. Swap in `isolated-vm` for hardening.
- **No live trading** — Qwen agent only simulates. A live exchange
  adapter is a separate service.
- **No leaderboard web UI** — the harness returns JSON. A Next.js
  dashboard is a 1-day addition.

## How to demo to judges

1. `cd workspace && npm install && npm run test:all` — show 143/143 pass.
2. `cd packages/backtester && uv sync --extra dev && cd ../..` — Python deps.
3. `npm --workspace packages/eval-harness run start &` — start the harness.
4. `npm run demo` — submit two agents, print the leaderboard.
5. Open a second terminal: `QWEN_API_KEY=... npm --workspace packages/qwen-agent run start -- --symbol BTCUSDT --duration 2m` — show the live Qwen agent making decisions.

## What's in the captured `demo/demo-output.txt`

The file in the zip is the **actual output from running the demo
end-to-end against the running services**. It's not a synthetic
mock — it's real `curl` output from the real eval-harness serving
real metrics from the real Python backtester. Use it as a quick
smoke test if you don't want to spin everything up.

## License

MIT. See `LICENSE`.
