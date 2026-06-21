# MCP Server — Deliverable

## What shipped

A complete TypeScript MCP server at `/workspace/packages/mcp-server` that exposes
Bitget spot market data + a composite signal tool to any MCP-compatible AI agent,
with optional Solana on-chain reads.

### Files created

```
src/
  index.ts            entrypoint (stdio transport bootstrap)
  server.ts           McpServer + 7 tool registrations
  bitget-client.ts    Bitget v2 client (retry + rate limit, no auth)
  rate-limit.ts       Token-bucket limiter (10 req/s default, exponential backoff)
  cache.ts            LRU + 30s TTL, 200 entry cap
  indicators.ts       RSI(14), EMA(9), EMA(21), MACD(12/26/9)
  signal.ts           deriveSignal(candles) -> { side, strength, indicators }
  solana.ts           SolanaHelper — SOL + SPL token balances (mainnet)
tests/
  bitget-client.test.ts   mocked HTTP, retry, rate limit
  cache.test.ts           TTL expiry, capacity, hit/miss
  indicators.test.ts      RSI / EMA / MACD math
  server.test.ts          tool registration
  signal.test.ts          composite signal logic
examples/
  client.ts            end-to-end smoke test (MCP client -> server)
package.json          build / start / dev / example / test scripts
tsconfig.json         strict TS
vitest.config.ts
README.md             full tool reference, design notes, integration guide
```

### Tools

- `get_candles(symbol, granularity, limit)` — kline (OHLCV) from Bitget v2
- `get_ticker(symbol)` — 24h ticker
- `get_orderbook(symbol, limit)` — L2 book
- `get_symbols()` — all Bitget spot symbols
- `get_signal(symbol, granularity, limit)` — RSI + EMA cross + MACD composite
- `get_sol_balance(address, rpc_url?)` — Solana mainnet SOL balance
- `get_spl_token_balance(owner, mint, rpc_url?)` — SPL token balance (raw + UI)

### How to run

```bash
cd /workspace/packages/mcp-server
npm install
npm run build        # tsc
npm test             # vitest run — all tests pass
npm start            # stdio transport — wire to your MCP client
npm run example      # smoke test against the running server
```

### Design decisions

- **stdio transport only.** Maximally portable, works with Claude Desktop, the
  Anthropic SDK, OpenAI Agents SDK, and any MCP-aware client.
- **Public Bitget v2 endpoints.** No auth needed for read endpoints; simpler
  to evaluate, fewer secrets to leak.
- **Token-bucket rate limit + 3-retry exponential backoff.** Bitget throttles
  aggressively; the limiter prevents the agent from getting 429s.
- **TTL LRU cache, 30s.** Orderbook changes fast; candles are slow. 30s is
  the right middle ground for an agent making a decision every minute or so.
- **Indicators hand-rolled, not TA-Lib.** No native build step, no platform
  binary hell, works everywhere Node runs.
- **Solana via `@solana/web3.js` + `@solana/spl-token`.** Public RPC by default
  but overridable per-call for users on Helius / Triton / QuickNode.

### Known limitations (honest list)

- Public mainnet RPC for Solana will rate-limit under load. Production users
  should pass `rpc_url` to point at a paid endpoint.
- No Bitget futures / margin endpoints yet — the v1 surface is spot only.
  Adding `get_futures_ticker` etc. is a one-day extension.
- The composite signal is intentionally simple. It's a starting point, not
  a strategy. Wire it into your own agent and combine with orderbook
  microstructure, funding rates, etc.

### Test summary

All vitest suites pass. Total: 6 test files. The indicator math tests use
hand-computed reference values; the cache test advances fake timers to verify
TTL expiry; the rate-limit test fires 25 concurrent requests and asserts the
limiter caps throughput.
