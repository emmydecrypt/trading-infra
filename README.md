# Trading Infra — AI × Crypto Hackathon Submission

> **Track**: Trading Infra
> **Sponsors used**: Bitget (market data) · Qwen (LLM) · open standards (MCP, stdio)
> **Status**: complete, tested, demoable
> **One-command run**: `npm install && npm run test:all && npm run demo`

A complete, composable infrastructure stack for AI trading agents on crypto.
Four cooperating services, one shared schema, zero vendor lock-in.

```
┌─────────────────┐     MCP/stdio     ┌──────────────────┐
│  Qwen Agent     │ ◀───────────────▶ │  MCP Server      │
│  (decision LLM) │   get_candles     │  (Bitget data +  │
│                 │   get_signal      │   signal tools)  │
└────────┬────────┘   get_orderbook   └─────────┬────────┘
         │                                     │
         │ action                              │ metrics
         ▼                                     ▼
┌─────────────────┐   spawns   ┌──────────────────────────────┐
│  Portfolio      │            │  Backtester (Python)         │
│  (simulated)    │            │  realistic slippage/fees/   │
└─────────────────┘            │  latency/partial fills       │
                               └─────────────┬────────────────┘
                                             │ metrics JSON
                                             ▼
                               ┌──────────────────────────────┐
                               │  Eval Harness (Node)         │
                               │  leaderboard + composite     │
                               │  score, vm sandbox for       │
                               │  agent code, SQLite store    │
                               └──────────────────────────────┘
```

## What's inside

| Package | What it does | Tech |
|---|---|---|
| **`packages/mcp-server`** | Exposes Bitget spot market data + RSI/EMA/MACD signal tool to any MCP-compatible agent. Also includes Solana on-chain reads. | TypeScript, MCP SDK, zod, LRU cache, rate limiter |
| **`packages/backtester`** | Realistic execution sim (slippage, fees, latency, partial fills) and the standard metrics suite. Runs as CLI or library. | Python, pydantic, numpy, pandas |
| **`packages/eval-harness`** | HTTP service that sandboxes agent submissions in a `vm`, runs them against the backtester, and ranks them on a composite score. | TypeScript, Fastify, better-sqlite3, zod |
| **`packages/qwen-agent`** | Reference end-to-end agent: spawns the MCP server, calls Qwen with function-calling, applies the decision to a simulated portfolio. | TypeScript, MCP client, OpenAI-compatible fetch |

## Quick start

```bash
# 1. Clone
git clone <this-repo> trading-infra
cd trading-infra

# 2. Install
npm install
# Python deps (for the backtester)
cd packages/backtester && uv sync --extra dev && cd ../..

# 3. Configure
cp .env.example .env
# Edit .env — at minimum, set QWEN_API_KEY (sponsor-supplied)

# 4. Verify everything works
npm run test:all

# 5. Run the demo (starts services, submits two agents, prints leaderboard)
npm run demo
```

## Run with Docker

```bash
docker compose up --build
# mcp-server, eval-harness, qwen-agent all start
# eval-harness: http://localhost:4000
```

## Architecture

### Data flow

1. **Agent** (in any language, MCP-compatible) wants to make a trading decision.
2. It calls `get_candles` / `get_ticker` / `get_orderbook` / `get_signal` on the **MCP server**.
3. The MCP server fetches from **Bitget v2** (public, no auth needed), with a 30s LRU cache and a 10 req/s token-bucket rate limit.
4. The agent uses the data to decide an Action (`buy | sell | hold`, with `size_pct`).
5. For evaluation, the agent's code is submitted to the **eval-harness** which:
   - Sandboxes it in a Node `vm` (1s per-call timeout).
   - Runs it against the **backtester** on a fixed dataset (BTCUSDT, ETHUSDT, SOLUSDT, 1h, 2024).
   - Records Sharpe, Sortino, Calmar, max drawdown, profit factor, win rate, total return.
   - Computes a **composite score** and publishes the agent to the leaderboard.

### Composite score

```text
composite = 0.40 * sharpe
          + 0.20 * sortino
          + 0.20 * calmar
          + 0.10 * profit_factor
          + 0.10 * max(0, min(1, 1 + max_drawdown))
```

The `max_drawdown` term is clamped to `[0, 1]` so a broken backtest returning
`-99.9` DD can't tank the leaderboard. The `profit_factor` term is unbounded;
a value of 5 contributes 0.5 to the score.

### Why this wins the "Trading Infra" track

Judges are looking for tools that make **every agent** run better — not just
a single agent. We deliver four:

1. **A plug-and-play data layer** (MCP server). Any agent, any language, gets
   Bitget data and signal tools instantly. No SDK lock-in.
2. **A honest execution simulator** (backtester). Realistic slippage, fees,
   latency, partial fills. Strategies that pass the backtest are
   strategies that have a chance in production.
3. **A neutral scoring layer** (eval-harness). Standardized metrics, sandboxed
   submissions, public leaderboard. The same infra could run the entire
   hackathon.
4. **A reference end-to-end demo** (Qwen agent). Proves the whole stack
   works with the sponsor's own LLM — and gives judges a runnable example
   to copy.

## API quick reference

```bash
# Submit an agent
curl -X POST http://localhost:4000/agents/submit \
  -H 'content-type: application/json' \
  -d '{"name":"my-strat","author":"me","code":"export function strategy(m,p){return {side:\"hold\"};}"}'

# Get the leaderboard
curl 'http://localhost:4000/leaderboard?metric=composite&limit=20'

# Health check
curl http://localhost:4000/health
```

## Sponsor tech used

- **Bitget** — primary market data source (v2 public REST API).
- **Qwen** — decision LLM in the reference agent (`qwen-plus` default).
- **MCP** — the lingua franca for agent tool-calls (open standard, Anthropic-maintained).
- **Solana Foundation** — optional on-chain read tools (`get_sol_balance`, `get_spl_token_balance`) for wallet-aware strategies.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Agent data | MCP server, TypeScript | Open standard, language-agnostic |
| LLM client | OpenAI-compatible fetch | Qwen ships a fully compatible endpoint |
| Backtester | Python + pydantic + numpy | Best quant ecosystem, pydantic for schemas |
| Eval | Fastify + better-sqlite3 | Fast, sync DB, zero ops |
| Sandbox | Node `vm` | Sub-millisecond startup, sufficient for competition code |
| Tests | vitest (TS) + pytest (Py) | The standard, fast and reliable |
| Packaging | npm workspaces + uv | Lightweight monorepo, no Lerna/Nx bloat |

## Limitations & future work

This is an honest list. Every infra project has gaps.

- **Public Bitget API** — no auth needed for read endpoints, but adding private
  (account, orders, fills) requires API keys.
- **Public Solana RPC** — fine for the demo, rate-limited for production.
  Users should override `SOLANA_RPC_URL` with a paid endpoint.
- **Single-symbol portfolio** per backtest run. Multi-symbol portfolio
  backtests with rebalancing are a v2 feature.
- **No market-impact model** in the backtester (slippage is flat bps).
  Real impact is `~ sqrt(size/ADV) * sigma * X` — out of scope for v1.
- **Sandbox is `node:vm`**, not `isolated-vm`. Sufficient for non-malicious
  competition code. For a public leaderboard open to the internet, swap in
  `isolated-vm` or a real container.
- **No live trading.** The Qwen agent only simulates. Wiring up a live
  exchange adapter is a separate service (and a separate set of decisions
  about risk limits, kill switches, etc.).

## Repo layout

```
trading-infra/
├── package.json              # npm workspaces
├── docker-compose.yml        # one-command bring-up
├── .env.example
├── .gitignore
├── README.md                 # this file
├── demo/
│   ├── demo.sh               # reproducible demo script
│   └── demo-output.txt       # captured output
├── docs/
│   └── ARCHITECTURE.md       # deep dive
└── packages/
    ├── mcp-server/           # TypeScript — Bitget + signal tools
    ├── backtester/           # Python  — realistic execution sim
    ├── eval-harness/         # TypeScript — leaderboard + sandbox
    └── qwen-agent/           # TypeScript — reference end-to-end agent
```

## License

MIT. See `LICENSE`.
