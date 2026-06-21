# Architecture

A deeper look at how the four packages fit together, why each boundary exists,
and the contracts that hold them together.

## Why four packages?

The hackathon's "Trading Infra" track rewards tools that *other agents* will
use. That implies three distinct concerns:

1. **Data acquisition** — fetching and normalizing market data from
   multiple sources. (`mcp-server`)
2. **Measurement** — running strategies under realistic execution and
   scoring them on standard metrics. (`backtester` + `eval-harness`)
3. **Reference implementation** — proving the above work end-to-end with
   the sponsor's LLM. (`qwen-agent`)

Each is a separate package because each has a different audience, lifecycle,
and update cadence. The MCP server will be touched when Bitget ships new
endpoints; the backtester is essentially stable; the eval-harness gets
extended as the scoring criteria evolve; the Qwen agent is replaced whenever
a new sponsor LLM comes online.

## Contract: the Action schema

The single shared type that ties everything together. Defined in
`qwen-agent/src/action.ts` and consumed by the eval-harness sandbox:

```ts
type Action =
  | { side: 'hold' }
  | { side: 'buy';  symbol: string; size_pct: number /* 0..1 */ }
  | { side: 'sell'; symbol: string; size_pct: number /* 0..1 */ };
```

`size_pct` is a fraction of available cash (for buys) or held position
(for sells). Strictly typed; anything else is a parse error and the agent
holds. This is the most important safety property of the whole system.

## Contract: the Metrics schema

Defined in `eval-harness/src/types.ts` and emitted by the Python
backtester as JSON:

```ts
interface Metrics {
  total_return: number;
  annualized_return: number;
  sharpe: number;        // annualized, sqrt(252)
  sortino: number;       // annualized, downside-only
  calmar: number;        // annualized / |max_drawdown|
  max_drawdown: number;  // negative fraction, e.g. -0.18
  win_rate: number;      // 0..1
  profit_factor: number; // gross_wins / gross_losses
  exposure: number;      // 0..1, fraction of bars with open position
  n_trades: number;
  n_bars: number;
  start_equity: number;
  end_equity: number;
  total_fees: number;
}
```

The Python backtester and the TypeScript eval-harness share this schema
verbatim. The eval-harness deserializes the backtester's JSON output
through zod, so any schema drift fails loudly at submit time.

## Contract: MCP tool schemas

The MCP server publishes 7 tools. Each has a zod-validated input schema
and a JSON output. The Qwen agent converts these to OpenAI function-calling
format on the fly. New tools can be added in `mcp-server/src/server.ts` and
they're automatically available to every MCP client.

## Sandbox boundary

The eval-harness runs user-submitted code in a `node:vm` context. The
sandbox is *not* a security boundary — it's a competition boundary. Sufficient
for non-malicious competition code, not sufficient for hostile public input.

For a public leaderboard, the recommended hardening is:
1. Replace `node:vm` with `isolated-vm` (true memory isolation).
2. Or run each submission in a fresh Docker container with seccomp.
3. Rate-limit submissions per author.

## Data flow with timings

```
[Agent]──> MCP client ──> MCP server ──> Bitget v2 (https)
                  │              │
                  │ 30s LRU      │ 3 retries, 10 req/s
                  │ cache hit    │ token bucket
                  ▼              │
[Agent]◀── JSON tool result ◀───┘

[Agent submit] ──> eval-harness ──> backtester (Python subprocess)
                        │                  │
                        │ 1s per-call       │ realistic execution
                        │ timeout           │ slippage/fees/latency
                        ▼                   ▼
                   SQLite store ◀───── JSON metrics
```

## Sponsor-tech fit

- **Bitget** — public v2 REST API, no auth needed for candles/orderbook/ticker.
  Our `mcp-server` is the only piece that talks to Bitget directly; everything
  else talks to the MCP server.
- **Qwen** — OpenAI-API-compatible, function-calling supported. Our
  `qwen-agent` uses `fetch` to hit `https://dashscope.aliyuncs.com/compatible-mode/v1`
  with the standard Chat Completions + tools payload. No custom SDK, no lock-in.
- **MCP** — the wire protocol between our agent and our server. Open standard
  maintained by Anthropic but engine-agnostic. Switching to any other LLM
  provider's MCP-compatible client is a 10-line change.
- **Solana Foundation** — `@solana/web3.js` + `@solana/spl-token` for the
  optional on-chain tools. Public mainnet RPC by default; override per call.

## Things we deliberately did NOT build (v1)

- **A live trading adapter.** Submitting real orders to Bitget is one
  service away but raises a different set of concerns (risk limits, kill
  switches, position reconciliation). Out of scope.
- **A web UI for the leaderboard.** The eval-harness returns JSON. A
  Next.js dashboard would be a 1-day addition and the eval-harness
  already has the API surface for it.
- **WebSocket / streaming.** Both Bitget and Solana support it; we use
  REST for the v1 because it's simpler and the agent decision cadence
  is per-minute, not per-tick.
- **Multi-symbol portfolio backtests.** A v2 feature.
- **Funding rates / perps.** We're spot-only in v1.

## Why this design survives a hackathon

1. **Each package is independently testable.** The verifier for the
   backtester can re-derive Sharpe by hand; the verifier for the MCP
   server can call the tools live. No "it works on my machine".
2. **Each package has an honest README.** Limitations are listed, not
   hidden. Judges respect this.
3. **The contract surfaces are small and stable.** Three types (Action,
   Metrics, MCP tool schema) hold the whole system together. Change
   them and you have a v2.
4. **The reference agent is the demo.** Judges can `npm run start` and
   see a Qwen-powered agent making decisions in real-time. No mock data,
   no faked outputs.
