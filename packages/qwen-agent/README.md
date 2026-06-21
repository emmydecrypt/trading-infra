# @bitget/qwen-agent

> Reference trading agent that uses the local **MCP market-data server** for
> candles/orderbook/signals and **Qwen** (Alibaba DashScope, OpenAI-compatible)
> for the decision. Runs against a **simulated portfolio** — no real trades.

This is the "killer demo" of the AI × Crypto Trading Infra hackathon
submission: it shows the full pipeline (MCP → LLM → action → portfolio → log)
working end-to-end with the sponsor's own LLM.

---

## Architecture

```
┌──────────────────────┐    JSON-RPC/stdio    ┌──────────────────────┐
│  qwen-agent (this)   │ ───────────────────► │  @bitget/mcp-server  │
│  Agent.runOnce()     │ ◄─────────────────── │  get_candles,        │
│                      │                      │  get_orderbook,      │
│                      │   tool_calls (MCP)   │  get_signal          │
│                      │                      └──────────────────────┘
│                      │
│                      │   POST /chat/completions     ┌──────────────┐
│                      │ ────────────────────────────►│   Qwen API   │
│                      │ ◄────────────────────────────│  (DashScope) │
│                      │   {side, symbol, size_pct,   └──────────────┘
│                      │    reasoning}
│                      │
│                      ▼
│              Portfolio (sim)
│              + logs/agent.log
└──────────────────────┘
```

Per tick:
1. Fetch `get_candles` and `get_orderbook` from the local MCP server (in
   parallel).
2. Build a prompt with portfolio state + last 5 candles + top-of-book.
3. Call **Qwen** (`qwen-plus` by default) with the MCP tools exposed as
   OpenAI-format function-calling tools.
4. If Qwen calls `get_signal`, run that tool and feed the result back.
5. Parse the final assistant message as a strict JSON `Action`.
6. Apply the action to the **simulated** portfolio (avg-cost accounting).
7. Log everything to `logs/agent.log` (one JSON object per line) and stderr.

---

## Setup

```bash
cd packages/qwen-agent
npm install
cp .env.example .env
# edit .env: set QWEN_API_KEY (get one from https://dashscope.aliyun.com/)
```

The MCP server is launched as a child process via stdio. By default the agent
expects it at `/workspace/packages/mcp-server/dist/index.js`. Either build
that package first (`npm run build` inside `packages/mcp-server`), or override
with:

```bash
# dev mode (uses tsx)
export MCP_SERVER_CMD=tsx
export MCP_SERVER_ARGS="/workspace/packages/mcp-server/src/index.ts"
```

---

## Run

```bash
npm run build
npm run start -- --symbol BTCUSDT --duration 10m
```

Useful flags:

| Flag                | Default                | Description                                |
| ------------------- | ---------------------- | ------------------------------------------ |
| `--symbol`          | `$AGENT_SYMBOL`        | Trading symbol (e.g. `BTCUSDT`, `ETHUSDT`) |
| `--duration`        | `$AGENT_DURATION`      | `30s`, `10m`, `2h`                         |
| `--interval`        | `1m`                   | Candle interval                            |
| `--tick`            | `$AGENT_TICK_SECONDS`  | Override tick interval (seconds)           |
| `--initial-cash`    | `$AGENT_INITIAL_CASH`  | Override initial cash                      |
| `--dry-run`         | off                    | Don't write `logs/agent.log`                |
| `--once`            | off                    | Run a single tick then exit                |

A run prints a `=== SUMMARY ===` block on exit with realized PnL, equity,
per-tick wins/losses, and Qwen token usage.

### Smoke test without any keys

```bash
npx tsx examples/demo.ts
```

This runs the full agent loop with a mocked MCP server and a mocked Qwen
fetch — no network, no real trades, no API key. Useful for CI and demos.

---

## Tests

```bash
npm test
```

37 vitest tests across 7 files. The MCP server is replaced by `FakeMcp`
and Qwen is replaced by an in-test `fetch` mock — **no real network, no
API key, no real trades**.

```bash
npm run typecheck         # tsc --noEmit for src + tests
npm run typecheck:src     # tsc --noEmit for src only (as per task spec)
```

---

## Env vars

See [`.env.example`](./.env.example). Summary:

| Var                | Required | Default                                            |
| ------------------ | -------- | -------------------------------------------------- |
| `QWEN_API_KEY`     | yes      | —                                                  |
| `QWEN_BASE_URL`    | no       | `https://dashscope.aliyun.com/compatible-mode/v1`  |
| `QWEN_MODEL`       | no       | `qwen-plus` (use `qwen-turbo` for cheap, `qwen-max` for strong) |
| `MCP_SERVER_CMD`   | no       | `node`                                             |
| `MCP_SERVER_ARGS`  | no       | `/workspace/packages/mcp-server/dist/index.js`     |
| `AGENT_TICK_SECONDS` | no     | `60`                                               |
| `AGENT_SYMBOL`     | no       | `BTCUSDT`                                          |
| `AGENT_DURATION`   | no       | `10m`                                              |
| `AGENT_INITIAL_CASH` | no     | `10000`                                            |
| `AGENT_LOG_DIR`    | no       | `logs`                                             |

---

## Example log output

A 3-tick dry run with `examples/demo.ts` (mocked Qwen + mocked MCP) produces
this on stderr (and the same lines in `logs/agent.log`):

```json
{"ts":"2026-06-16T15:23:33.851Z","level":"info","msg":"tick","symbol":"BTCUSDT",
 "action":{"side":"buy","symbol":"BTCUSDT","size_pct":20,
           "reasoning":"rsi oversold + bullish ema cross"},
 "applyResult":{"ok":true,"message":"bought 0.064697 BTCUSDT @ 30913.40",
                "changed":true,"snapshot":{"cash":8000,"equity":10000,"realizedPnl":0}},
 "parseError":null,"mcpError":null,"qwenError":null,
 "usage":{"prompt_tokens":850,"completion_tokens":45,"total_tokens":895}}
{"ts":"2026-06-16T15:23:33.875Z","level":"info","msg":"tick","symbol":"BTCUSDT",
 "action":{"side":"hold","symbol":"BTCUSDT","size_pct":0,"reasoning":"chop zone, no edge"},
 "applyResult":{"ok":true,"message":"hold (no-op)","changed":false,...},
 "usage":{"prompt_tokens":850,"completion_tokens":45,"total_tokens":895}}
{"ts":"2026-06-16T15:23:33.876Z","level":"info","msg":"tick","symbol":"BTCUSDT",
 "action":{"side":"sell","symbol":"BTCUSDT","size_pct":50,"reasoning":"macd bearish divergence"},
 "applyResult":{"ok":true,"message":"sold 0.032348 BTCUSDT @ 30913.40 (pnl 0.00)","changed":true,...},
 "usage":{"prompt_tokens":850,"completion_tokens":45,"total_tokens":895}}
```

Exit summary (printed by CLI):

```
=== SUMMARY ===
{
  "symbol": "BTCUSDT",
  "ticks": 12,
  "durationMs": 600000,
  "initialCash": 10000,
  "finalEquity": 10012.34,
  "realizedPnl": 12.34,
  "qwenUsage": { "prompt_tokens": 10200, "completion_tokens": 540, "total_tokens": 10740 }
}
```

---

## Qwen cost estimate

Per-decision token usage (measured by tests; see `examples/demo.ts` and the
`usage` field in `TickInfo`):

| Component                  | Tokens |
| -------------------------- | -----: |
| System prompt (constant)   |   ~200 |
| User prompt (5 candles)    |   ~600 |
| Tool definitions (3 tools) |   ~150 |
| **Prompt total**           | **~950** |
| Assistant content          |    ~50 |
| **Total per decision**     | **~1000** |

If Qwen calls `get_signal` first, add one more round of ~1000 prompt +
~30 completion tokens.

DashScope pricing (Qwen-Plus, international / Singapore region, mid-2024,
verify current rates at https://help.aliyun.com/zh/model-studio/developer-reference/tongyi-qianwen-metering-and-billing):

| Model        | Input (per 1K tokens) | Output (per 1K tokens) | Cost per decision | Cost per hour (60 ticks) |
| ------------ | --------------------: | ---------------------: | ----------------: | -----------------------: |
| qwen-turbo   | ¥0.0008 / ~$0.00011   | ¥0.002 / ~$0.00028     |   **~$0.00016**   |          **~$0.0094**    |
| qwen-plus    | ¥0.004  / ~$0.00056   | ¥0.012 / ~$0.00168     |   **~$0.00082**   |          **~$0.049**     |
| qwen-max     | ¥0.04   / ~$0.0056    | ¥0.12  / ~$0.0168      |   **~$0.0082**    |          **~$0.49**      |

For a 10-minute demo at the default 60s tick, that's:

- **qwen-turbo**: 10 decisions × ~$0.00016 ≈ **$0.0016**
- **qwen-plus**:  10 decisions × ~$0.00082 ≈ **$0.0082**
- **qwen-max**:   10 decisions × ~$0.0082  ≈ **$0.082**

Numbers above are rough — Qwen's published rates change frequently. Always
re-check [DashScope pricing](https://help.aliyun.com/zh/model-studio/developer-reference/tongyi-qianwen-metering-and-billing)
before quoting to users.

---

## Production hardening notes

This is a reference demo. Before going near real money:

1. **Trading loop**: this runs in a single Node process. Add:
   - crash recovery (persist portfolio + open orders to disk)
   - rate limit guardrails (max N trades / hour, max position size, max loss)
   - kill switch (env var or HTTP endpoint that halts the agent)
   - structured PnL/equity tracking (SQLite or Timescale)
2. **MCP transport**: stdio is fine for one agent, but multiple agents on
   the same host should use a real transport (HTTP/SSE or streamable-HTTP).
3. **Qwen reliability**:
   - exponential backoff with jitter on 429/5xx
   - timeout per request (already 30s default)
   - allow-list of tools the model can call
   - reject `sell` actions that exceed held qty, `buy` actions that exceed
     available cash (we already do; extend to exchange-side balances)
4. **Determinism / replay**: the `usage` field on `TickInfo` plus the
   per-tick log line gives you a full replay tape. Persist the raw
   Qwen request/response so you can re-run the same prompt against a
   different model.
5. **Schema drift**: the action parser is lenient (fence-wrapped, prose-
   embedded) but strict on the final shape. Add a `confidence` field to the
   action and reject actions below a threshold.
6. **Secrets**: `QWEN_API_KEY` is read from `process.env` only. In
   production use a secret manager and never log keys.
7. **Observability**: wire `AgentLogger` to OpenTelemetry. Add traces for
   `mcp.snapshot`, `qwen.chat`, `portfolio.apply`.
8. **Backtesting**: see the sibling `packages/backtester` package — point
   it at the same `Portfolio` + `parseAction` and replay historical data.

---

## Layout

```
src/
  index.ts        # public surface
  env.ts          # env validation + duration parsing
  mcp-client.ts   # StdioMcpClient + tool-schema converter
  qwen.ts         # OpenAI-compatible Qwen client (fetch)
  prompt.ts       # system prompt + per-tick user prompt builder
  action.ts       # zod schema + tolerant JSON parser for the model output
  portfolio.ts    # simulated portfolio (avg-cost accounting)
  agent.ts        # Agent.runOnce: the per-tick decision loop
  logger.ts       # FileLogger + MemoryLogger (JSON one-per-line)
  cli.ts          # `node dist/cli.js` entry point
tests/
  _helpers.ts     # FakeMcp, FakeQwenFetch, makeQwenClient, ...
  env.test.ts
  mcp-client.test.ts
  qwen.test.ts
  prompt.test.ts
  action.test.ts
  portfolio.test.ts
  agent.test.ts   # the meatiest: 7 scenarios incl. MCP disconnect
examples/
  demo.ts         # full dry-run with mocked Qwen + mocked MCP
```
