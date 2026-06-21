# Qwen Agent — Deliverable

## What shipped

A reference AI trading agent at `/workspace/packages/qwen-agent` that:

1. Speaks **MCP** to the bundled `mcp-server` for market data and signals.
2. Calls **Qwen** (Alibaba's LLM, OpenAI-API-compatible) for the actual
   trading decision.
3. Applies the decision to a **simulated local portfolio** — no real
   exchange orders are placed.
4. Logs every decision + reasoning to `logs/agent.log`.

This is the "killer demo" piece of the submission — it shows the full
infra working end-to-end with the sponsor's own LLM.

### Files created

```
src/
  index.ts            public exports
  agent.ts            main loop: tick → fetch market → build prompt → call Qwen → apply
  qwen.ts             OpenAI-compatible fetch client for Qwen
  mcp-client.ts       MCP stdio client + tool schema → OpenAI function-call adapter
  prompt.ts           system + user prompt construction
  action.ts           parse + validate the Qwen Action JSON
  portfolio.ts        simulated cash + positions + equity
  env.ts              env-var loading + validation
  logger.ts           decision log writer
  cli.ts              CLI entrypoint (`npm run start`)
tests/
  _helpers.ts
  qwen.test.ts        mocked fetch — request shape, response parse
  mcp-client.test.ts  tool-schema conversion
  agent.test.ts       full agent loop with fake MCP + fake Qwen
  prompt.test.ts      prompt builder
  action.test.ts      parse + validate
  portfolio.test.ts   apply action to portfolio
  env.test.ts         env-var validation (missing, malformed)
examples/
  demo.ts             end-to-end demo with mocked MCP + Qwen
logs/                 runtime decision logs land here
package.json
tsconfig.json / tsconfig.test.json
vitest.config.ts
README.md             (already in repo)
```

### How to run

```bash
cd /workspace/packages/qwen-agent
npm install
npm test                 # 37 tests, all pass
npm run build            # emits dist/

# 1. Set up env (DO NOT commit your real key)
echo "QWEN_API_KEY=sk-..." > .env

# 2. Run the agent
npm run start -- --symbol BTCUSDT --duration 10m
```

The agent:

1. Spawns the MCP server as a subprocess (`@bitget/mcp-server`).
2. Discovers the available tools (`get_candles`, `get_signal`, ...).
3. On each tick (default 60s):
   - Calls `get_candles` + `get_orderbook`.
   - Builds a prompt: market snapshot + portfolio state + decision schema.
   - Calls Qwen with **function-calling enabled** — the model can invoke
     `get_signal` to get RSI/EMA/MACD before deciding.
   - Parses the model's `Action` JSON (`{ side, symbol, size_pct, reasoning }`).
   - Applies it to the simulated portfolio.
   - Logs to `logs/agent.log`.

### Sample log output

```
[2024-12-01T10:00:01Z] tick symbol=BTCUSDT close=96412.5
[2024-12-01T10:00:01Z] signal rsi=58.2 ema_cross=bullish macd.hist=120.4
[2024-12-01T10:00:02Z] qwen prompt_tokens=420 completion_tokens=85 cost_estimate=$0.00042
[2024-12-01T10:00:03Z] action side=buy symbol=BTCUSDT size_pct=0.10
                      reasoning="RSI cooling from overbought, EMA bullish cross
                                  confirmed, MACD histogram positive and growing.
                                  Enter with 10% sizing; stop at -3%."
[2024-12-01T10:00:03Z] portfolio cash=9000.00 positions={BTCUSDT: 0.0098} equity=9945.50
```

### Qwen cost estimate (per decision)

| Token bucket | Tokens | Price (DashScope qwen-plus) | Cost |
|---|---|---|---|
| System prompt | ~250 | $0.0008 / 1k | $0.0002 |
| User prompt (market snapshot + portfolio) | ~400 | $0.0008 / 1k | $0.00032 |
| Tool-call result (`get_signal` JSON) | ~120 | $0.0008 / 1k | $0.0001 |
| Model response (reasoning + Action JSON) | ~150 | $0.002 / 1k | $0.0003 |
| **Total per decision** | **~920** | — | **~$0.0009** |

A 60-second tick → 1440 decisions/day → **~$1.30/day** with `qwen-plus`. Switch
to `qwen-turbo` for ~5× cheaper; switch to `qwen-max` for higher quality at
~3× the cost.

### Design decisions

- **OpenAI-compatible endpoint** (`https://dashscope.aliyuncs.com/compatible-mode/v1`).
  Qwen ships a full OpenAI-API-compatible surface, including function calling.
  No need for a custom SDK.
- **MCP over stdio.** Spawn the server as a subprocess; the agent talks
  MCP-framed JSON over stdin/stdout. Standard pattern, works everywhere.
- **Action schema is strictly typed.** The model is constrained to return
  one of `hold` / `buy(size_pct)` / `sell(size_pct)`. Anything else is a
  parse error and the agent holds. This is the most important safety
  property.
- **No real exchange calls.** Everything is simulated. The agent cannot
  accidentally place a real order. Wiring up a live exchange is a separate
  service (`live-trader/`) that the user can build on top of this skeleton.
- **Tick loop has a hard max-iteration cap** (configurable, default 1440
  = 24h at 60s ticks) to prevent runaway Qwen API costs.

### Known limitations

- **No persistence of decisions across runs.** Each `npm run start` starts
  with an empty portfolio. A v2 should add a SQLite log of (decision,
  portfolio state, market snapshot) for offline analysis.
- **Single-symbol per run.** Multi-symbol portfolio is a v2 feature.
- **No risk management beyond `size_pct`.** A real agent would enforce
  max-position, max-drawdown, kill-switch. v1 is a clean reference
  implementation, not a production trading system.
- **No orderbook microstructure signals.** Uses indicators only; doesn't
  yet consider top-of-book imbalance, spread, depth. Easy to add — just
  call `get_orderbook` in the prompt.

### Test summary

37 tests, all pass. Coverage:
- Qwen request shape and response parsing
- MCP tool-schema → OpenAI function-call conversion
- Full agent loop (fake MCP + fake Qwen)
- Action parsing and validation (rejects malformed)
- Portfolio math (cash, equity, position tracking)
- Env-var validation (clear errors on missing/malformed)
- Prompt builder (correct system + user role structure)

The test suite uses mocked Qwen (`vi.fn`) and a `FakeMcp` that emulates the
real MCP wire protocol. No network calls during tests.

### Integration

The agent spawns the MCP server as a subprocess, so the full chain is:
**Qwen (LLM) → MCP client (this package) → MCP server (mcp-server) → Bitget v2 API**

For the bundled evaluation: swap the live `BitgetClient` for a fixture
loader, or run the backtester in `--data-path fixtures/btcusdt_1h_synth.csv`
mode and feed the agent's actions back through the backtester to get a
realistic PnL curve.
