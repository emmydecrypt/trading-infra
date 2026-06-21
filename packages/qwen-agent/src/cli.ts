#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   npm run start -- --symbol BTCUSDT --duration 10m
 *
 * Flags:
 *   --symbol <SYM>        Trading symbol (default BTCUSDT or $AGENT_SYMBOL)
 *   --duration <10m|2h>   Total run duration (default 10m or $AGENT_DURATION)
 *   --interval <1m|5m>    Candle interval (default 1m)
 *   --tick <seconds>      Override tick interval (default from $AGENT_TICK_SECONDS)
 *   --initial-cash <n>    Override initial cash
 *   --dry-run             Don't write logs/agent.log
 *   --once                Run a single tick then exit (useful for smoke tests)
 *   --help                Print this help
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, parseDurationString } from "./env.js";
import { StdioMcpClient } from "./mcp-client.js";
import { QwenClient } from "./qwen.js";
import { Agent } from "./agent.js";
import { Portfolio } from "./portfolio.js";
import { FileLogger } from "./logger.js";

interface CliArgs {
  symbol?: string;
  duration?: string;
  interval?: string;
  tickSeconds?: number;
  initialCash?: number;
  dryRun: boolean;
  once: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { dryRun: false, once: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    switch (a) {
      case "--symbol":
        out.symbol = next;
        i++;
        break;
      case "--duration":
        out.duration = next;
        i++;
        break;
      case "--interval":
        out.interval = next;
        i++;
        break;
      case "--tick":
        out.tickSeconds = Number(next);
        i++;
        break;
      case "--initial-cash":
        out.initialCash = Number(next);
        i++;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--once":
        out.once = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`Unknown flag: ${a}`);
          process.exitCode = 2;
        }
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`qwen-agent — reference Qwen-powered trading agent

Usage:
  npm run start -- --symbol BTCUSDT --duration 10m

Flags:
  --symbol <SYM>        Trading symbol (default: $AGENT_SYMBOL or BTCUSDT)
  --duration <10m|2h>   Run duration (default: $AGENT_DURATION or 10m)
  --interval <1m|5m>    Candle interval (default: 1m)
  --tick <seconds>      Override tick interval
  --initial-cash <n>    Override initial cash
  --dry-run             Don't write logs/agent.log
  --once                Run a single tick then exit
  --help                Print this help

Required env: QWEN_API_KEY (others have defaults — see .env.example)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const cfg = loadConfig();
  const symbol = args.symbol ?? cfg.agent.symbol;
  const durationMs = args.duration ? parseDurationString(args.duration) : cfg.agent.durationMs;
  const tickMs = args.tickSeconds ? args.tickSeconds * 1000 : cfg.agent.tickMs;
  const initialCash = args.initialCash ?? cfg.agent.initialCash;
  const interval = args.interval ?? "1m";

  const here = path.dirname(fileURLToPath(import.meta.url));
  const logPath = args.dryRun
    ? undefined
    : path.resolve(here, "..", cfg.agent.logDir, "agent.log");
  const log = new FileLogger({ filePath: logPath, echo: true });

  log.info("startup", {
    symbol,
    durationMs,
    tickMs,
    interval,
    initialCash,
    mcp: cfg.mcp,
    qwen: { baseUrl: cfg.qwen.baseUrl, model: cfg.qwen.model },
  });

  const mcp = new StdioMcpClient({ command: cfg.mcp.command, args: cfg.mcp.args });
  const qwen = new QwenClient({
    baseUrl: cfg.qwen.baseUrl,
    apiKey: cfg.qwen.apiKey,
    model: cfg.qwen.model,
  });
  const portfolio = new Portfolio(initialCash);
  const agent = new Agent({
    mcp,
    qwen,
    portfolio,
    log,
    symbol,
    interval,
  });

  // Graceful shutdown.
  let stopped = false;
  const stop = async (sig: string) => {
    if (stopped) return;
    stopped = true;
    log.info("shutdown", { signal: sig });
    try {
      await mcp.close();
    } catch {
      /* ignore */
    }
    await log.flush();
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));

  try {
    const tools = await mcp.listTools();
    log.info("tools_loaded", { count: tools.length, names: tools.map((t) => t.function.name) });

    const startedAt = Date.now();
    let ticks = 0;
    let lastEquity = initialCash;
    let wins = 0;
    let losses = 0;
    let realized = 0;

    while (!stopped) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= durationMs) break;
      if (args.once) {
        await agent.runOnce({ tools: { openai: tools } });
        break;
      }
      const tickStart = Date.now();
      const info = await agent.runOnce({ tools: { openai: tools } });
      ticks++;
      if (info.applyResult?.changed && info.action && info.action.side !== "hold") {
        // naive realized pnl tracking just for the summary
      }
      realized = info.portfolioAfter.realizedPnl;
      if (info.portfolioAfter.equity > lastEquity) wins++;
      else if (info.portfolioAfter.equity < lastEquity) losses++;
      lastEquity = info.portfolioAfter.equity;

      // sleep remaining tick window, but exit early if duration reached
      const remaining = durationMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      const sleep = Math.min(tickMs - (Date.now() - tickStart), remaining);
      if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
    }

    const finalSnap = portfolio.snapshot();
    const usage = agent.usage();
    const summary = {
      symbol,
      ticks,
      durationMs,
      initialCash,
      finalEquity: finalSnap.equity,
      cash: finalSnap.cash,
      positions: finalSnap.positions,
      realizedPnl: finalSnap.realizedPnl,
      wins,
      losses,
      qwenUsage: usage,
    };
    log.info("summary", summary);
    console.log("\n=== SUMMARY ===");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await stop("exit");
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
