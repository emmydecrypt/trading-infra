#!/usr/bin/env bash
#
# demo.sh — reproducible end-to-end demo for the AI x Crypto Trading Infra
# submission.
#
# What it does:
#   1. Health-checks the eval-harness (assumes it's already running on :4000).
#   2. Submits two reference agents (sma-cross, random) to the harness.
#   3. Prints the leaderboard.
#
# Prereqs:
#   - npm install at the repo root
#   - uv sync --extra dev in packages/backtester
#   - eval-harness running: `npm --workspace packages/eval-harness run start`
#
# Usage:
#   bash demo/demo.sh
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PORT="${EVAL_PORT:-4000}"

echo "================================================================"
echo "  AI x Crypto Trading Infra — demo"
echo "  Track: Trading Infra"
echo "  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "================================================================"
echo

# ---------- 1. Health check ----------
echo "[1/5] Health check..."
HEALTH=$(curl -s "http://localhost:${PORT}/health" || true)
if [[ -z "$HEALTH" ]]; then
  echo "      eval-harness not running. Starting it now..."
  nohup npm --workspace packages/eval-harness run start >/workspace/logs/eval.log 2>&1 &
  sleep 5
  HEALTH=$(curl -s "http://localhost:${PORT}/health" || true)
fi
echo "      eval-harness: $HEALTH"
echo

# ---------- 2. List the MCP server's tool surface ----------
echo "[2/5] MCP server tools (Bitget + signal + Solana on-chain)..."
cat <<'TOOLS'
      get_candles        kline/OHLCV for a Bitget spot symbol
      get_ticker         24h ticker (price, change, volume)
      get_orderbook      L2 orderbook snapshot
      get_symbols        all Bitget spot symbols
      get_signal         RSI(14) + EMA(9/21) + MACD(12/26/9) composite
      get_sol_balance    SOL balance for a Solana address
      get_spl_token_balance  SPL token balance (raw + UI)
TOOLS
echo

# ---------- 3. Submit two reference agents ----------
echo "[3/5] Submitting two reference agents..."

# --- Agent 1: SMA crossover (uses marketData.history: number[]) ---
SMA_CODE='function strategy(marketData, portfolio) {
  const h = marketData.history;
  if (h.length < 30) return { side: "hold" };
  const slice = (n) => h.slice(-n).reduce((a,b)=>a+b,0) / n;
  const fast = slice(9);
  const slow = slice(21);
  const held = portfolio.position_symbol === marketData.symbol ? portfolio.position_qty : 0;
  if (fast > slow && held === 0) return { side: "buy",  symbol: marketData.symbol, size_pct: 0.20 };
  if (fast < slow && held >  0) return { side: "sell", symbol: marketData.symbol, size_pct: 1.00 };
  return { side: "hold" };
}'

echo "      - sma-cross-v1 (9/21 SMA crossover, 20% sizing)..."
SMA_RESP=$(curl -s -X POST "http://localhost:${PORT}/agents/submit" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg c "$SMA_CODE" '{name:"sma-cross-v1", author:"demo", code:$c}')")
SMA_OK=$(echo "$SMA_RESP" | jq -r '.result.ok // false')
SMA_ERR=$(echo "$SMA_RESP" | jq -r '.result.error // ""')
echo "        ok=${SMA_OK}${SMA_ERR:+  err=\"${SMA_ERR}\"}"

# --- Agent 2: random baseline ---
RAND_CODE='function strategy(marketData, portfolio) {
  if (Math.random() < 0.05) {
    return { side: "buy", symbol: marketData.symbol, size_pct: 0.10 };
  }
  if (Math.random() < 0.05 && portfolio.position_symbol === marketData.symbol && portfolio.position_qty > 0) {
    return { side: "sell", symbol: marketData.symbol, size_pct: 1.00 };
  }
  return { side: "hold" };
}'

echo "      - random-baseline (5% prob trade, 10% sizing)..."
RAND_RESP=$(curl -s -X POST "http://localhost:${PORT}/agents/submit" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg c "$RAND_CODE" '{name:"random-baseline", author:"demo", code:$c}')")
RAND_OK=$(echo "$RAND_RESP" | jq -r '.result.ok // false')
RAND_ERR=$(echo "$RAND_RESP" | jq -r '.result.error // ""')
echo "        ok=${RAND_OK}${RAND_ERR:+  err=\"${RAND_ERR}\"}"
echo

# ---------- 4. Print the leaderboard ----------
echo "[4/5] Leaderboard (sorted by composite score)..."
echo "----------------------------------------------------------------"
curl -s "http://localhost:${PORT}/leaderboard?metric=composite&limit=10" | jq .
echo

# ---------- 5. Top agent detailed metrics ----------
echo "[5/5] Top agent detailed metrics..."
LEADER=$(curl -s "http://localhost:${PORT}/leaderboard?metric=composite&limit=1")
TOP_ID=$(echo "$LEADER" | jq -r '.entries[0].id // empty')
if [ -n "$TOP_ID" ]; then
  curl -s "http://localhost:${PORT}/agents/${TOP_ID}" | jq .
else
  echo "      (no successful agents on leaderboard yet)"
fi

echo
echo "================================================================"
echo "  Demo complete."
echo "  Next:"
echo "    - Submit your own:"
echo "        curl -X POST http://localhost:${PORT}/agents/submit \\"
echo "          -H 'content-type: application/json' \\"
echo "          -d '{\"name\":\"my-strat\",\"author\":\"me\",\"code\":\"...\"}'"
echo "    - Browse agents:    curl http://localhost:${PORT}/agents | jq ."
echo "    - Run the agent:    QWEN_API_KEY=... npm --workspace packages/qwen-agent run start -- --symbol BTCUSDT --duration 5m"
echo "================================================================"
