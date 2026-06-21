/**
 * Environment + config loader. Validates required vars and provides sane defaults.
 *
 * Required:
 *   - QWEN_API_KEY      (DashScope / OpenAI-compatible key)
 *
 * Optional (with defaults):
 *   - QWEN_BASE_URL     (default https://dashscope.aliyun.com/compatible-mode/v1)
 *   - QWEN_MODEL        (default qwen-plus)
 *   - MCP_SERVER_CMD    (default "node")
 *   - MCP_SERVER_ARGS   (default "/workspace/packages/mcp-server/dist/index.js")
 *   - AGENT_TICK_SECONDS (default 60)
 *   - AGENT_SYMBOL      (default BTCUSDT)
 *   - AGENT_DURATION    (default 10m)
 *   - AGENT_INITIAL_CASH (default 10000)
 *   - AGENT_LOG_DIR     (default logs)
 */
import { z } from "zod";
import { config as loadDotenv } from "dotenv";

// Load .env from cwd first; fall back to package dir.
loadDotenv();
loadDotenv({ path: new URL("../.env", import.meta.url).pathname });

const DurationRegex = /^(\d+)\s*(s|m|h)?$/i;

function parseDuration(input: string | undefined, fallback: string): number {
  const raw = (input ?? fallback).trim();
  const m = raw.match(DurationRegex);
  if (!m) throw new Error(`Invalid duration: ${raw} (expected like 30s, 10m, 2h)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const ms = unit === "h" ? n * 3600_000 : unit === "m" ? n * 60_000 : n * 1000;
  return ms;
}

const EnvSchema = z.object({
  QWEN_API_KEY: z.string().min(1, "QWEN_API_KEY is required"),
  QWEN_BASE_URL: z
    .string()
    .url()
    .default("https://dashscope.aliyun.com/compatible-mode/v1"),
  QWEN_MODEL: z.string().min(1).default("qwen-plus"),
  MCP_SERVER_CMD: z.string().min(1).default("node"),
  MCP_SERVER_ARGS: z
    .string()
    .default("/workspace/packages/mcp-server/dist/index.js"),
  AGENT_TICK_SECONDS: z.coerce.number().int().positive().default(60),
  AGENT_SYMBOL: z.string().min(1).default("BTCUSDT"),
  AGENT_DURATION: z.string().default("10m"),
  AGENT_INITIAL_CASH: z.coerce.number().nonnegative().default(10_000),
  AGENT_LOG_DIR: z.string().min(1).default("logs"),
});

export type Env = z.infer<typeof EnvSchema>;

export interface ResolvedConfig {
  qwen: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  mcp: {
    command: string;
    args: string[];
  };
  agent: {
    tickMs: number;
    durationMs: number;
    symbol: string;
    initialCash: number;
    logDir: string;
  };
}

/**
 * Parse and validate env, returning a fully resolved config object.
 * Throws a descriptive error if validation fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const e = parsed.data;
  return {
    qwen: {
      apiKey: e.QWEN_API_KEY,
      baseUrl: e.QWEN_BASE_URL,
      model: e.QWEN_MODEL,
    },
    mcp: {
      command: e.MCP_SERVER_CMD,
      args: e.MCP_SERVER_ARGS.split(/\s+/).filter(Boolean),
    },
    agent: {
      tickMs: e.AGENT_TICK_SECONDS * 1000,
      durationMs: parseDuration(e.AGENT_DURATION, "10m"),
      symbol: e.AGENT_SYMBOL,
      initialCash: e.AGENT_INITIAL_CASH,
      logDir: e.AGENT_LOG_DIR,
    },
  };
}

/**
 * Parse a CLI --duration string like "10m", "30s", "2h" to milliseconds.
 * Exported for CLI use.
 */
export function parseDurationString(input: string): number {
  return parseDuration(input, "10m");
}
