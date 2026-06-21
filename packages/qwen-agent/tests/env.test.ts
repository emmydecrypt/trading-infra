import { describe, it, expect } from "vitest";
import { loadConfig, parseDurationString } from "../src/env.js";
import { withEnv } from "./_helpers.js";

describe("env.loadConfig", () => {
  const baseValid: Record<string, string> = {
    QWEN_API_KEY: "sk-test",
  };

  it("accepts minimal env and applies defaults", async () => {
    await withEnv(baseValid, () => {
      const cfg = loadConfig();
      expect(cfg.qwen.apiKey).toBe("sk-test");
      expect(cfg.qwen.baseUrl).toBe("https://dashscope.aliyun.com/compatible-mode/v1");
      expect(cfg.qwen.model).toBe("qwen-plus");
      expect(cfg.mcp.command).toBe("node");
      expect(cfg.mcp.args).toEqual(["/workspace/packages/mcp-server/dist/index.js"]);
      expect(cfg.agent.tickMs).toBe(60_000);
      expect(cfg.agent.symbol).toBe("BTCUSDT");
      expect(cfg.agent.durationMs).toBe(10 * 60_000);
      expect(cfg.agent.initialCash).toBe(10_000);
    });
  });

  it("parses explicit overrides", async () => {
    await withEnv(
      {
        ...baseValid,
        QWEN_BASE_URL: "https://my-proxy.test/v1",
        QWEN_MODEL: "qwen-turbo",
        MCP_SERVER_CMD: "tsx",
        MCP_SERVER_ARGS: "/tmp/mcp-server/src/index.ts --debug",
        AGENT_TICK_SECONDS: "5",
        AGENT_SYMBOL: "ETHUSDT",
        AGENT_DURATION: "2h",
        AGENT_INITIAL_CASH: "50000",
      },
      () => {
        const cfg = loadConfig();
        expect(cfg.qwen.baseUrl).toBe("https://my-proxy.test/v1");
        expect(cfg.qwen.model).toBe("qwen-turbo");
        expect(cfg.mcp.command).toBe("tsx");
        expect(cfg.mcp.args).toEqual(["/tmp/mcp-server/src/index.ts", "--debug"]);
        expect(cfg.agent.tickMs).toBe(5_000);
        expect(cfg.agent.symbol).toBe("ETHUSDT");
        expect(cfg.agent.durationMs).toBe(2 * 3600_000);
        expect(cfg.agent.initialCash).toBe(50_000);
      }
    );
  });

  it("rejects when QWEN_API_KEY is missing", async () => {
    await withEnv({}, () => {
      expect(() => loadConfig()).toThrow(/QWEN_API_KEY/);
    });
  });

  it("rejects invalid duration strings", () => {
    expect(() => parseDurationString("not-a-time")).toThrow();
    expect(() => parseDurationString("10y")).toThrow();
    // Bare number is valid (defaults to seconds).
    expect(parseDurationString("30")).toBe(30_000);
  });

  it("rejects invalid URLs / non-positive tick", async () => {
    await withEnv(
      { ...baseValid, QWEN_BASE_URL: "not-a-url", AGENT_TICK_SECONDS: "0" },
      () => {
        expect(() => loadConfig()).toThrow(/Invalid environment/);
      }
    );
  });
});
