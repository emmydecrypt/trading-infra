import { describe, it, expect } from "vitest";
import { mcpToolToOpenAITool } from "../src/mcp-client.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

describe("mcpToolToOpenAITool", () => {
  it("maps name, description, and inputSchema to OpenAI format", () => {
    const t: McpTool = {
      name: "get_candles",
      description: "Fetch OHLCV candles for a symbol",
      inputSchema: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
    };
    const o = mcpToolToOpenAITool(t);
    expect(o).toEqual({
      type: "function",
      function: {
        name: "get_candles",
        description: "Fetch OHLCV candles for a symbol",
        parameters: {
          type: "object",
          properties: { symbol: { type: "string" } },
          required: ["symbol"],
        },
      },
    });
  });

  it("omits description and parameters when not provided", () => {
    const t: McpTool = { name: "ping", inputSchema: { type: "object" } };
    const o = mcpToolToOpenAITool(t);
    expect(o.type).toBe("function");
    expect(o.function.name).toBe("ping");
    expect(o.function.description).toBeUndefined();
    expect(o.function.parameters).toEqual({ type: "object" });
  });
});
