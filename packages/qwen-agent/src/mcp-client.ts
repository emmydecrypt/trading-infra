/**
 * MCP client wrapper. Spawns the local MCP server over stdio and exposes a
 * narrow surface: list tools, call tools, disconnect.
 *
 * Tool schemas returned by the MCP server are converted to OpenAI
 * function-calling tool format so they can be passed straight to Qwen.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

/** OpenAI/Qwen function-calling tool shape. */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Public surface used by the agent. Tests substitute a fake. */
export interface McpClientLike {
  listTools(): Promise<OpenAITool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Convert one MCP tool to OpenAI function-calling format. */
export function mcpToolToOpenAITool(t: McpTool): OpenAITool {
  // MCP tool.inputSchema is a JSON Schema object. OpenAI accepts the same shape
  // for `parameters`. We forward it as-is.
  const fn: OpenAITool["function"] = { name: t.name };
  if (t.description) fn.description = t.description;
  if (t.inputSchema && typeof t.inputSchema === "object") {
    fn.parameters = t.inputSchema as Record<string, unknown>;
  }
  return { type: "function", function: fn };
}

export interface StdioMcpClientOptions {
  command: string;
  args: string[];
  /** Extra env passed to the spawned server. */
  env?: Record<string, string>;
  /** Client identity sent in MCP initialize. */
  clientName?: string;
  clientVersion?: string;
}

/** Concrete implementation that spawns the server over stdio. */
export class StdioMcpClient implements McpClientLike {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private connected = false;
  private toolsCache: OpenAITool[] | null = null;

  constructor(opts: StdioMcpClientOptions) {
    this.client = new Client(
      { name: opts.clientName ?? "qwen-agent", version: opts.clientVersion ?? "0.1.0" },
      { capabilities: {} }
    );
    this.transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    });
  }

  /** Connect to the server (idempotent). */
  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<OpenAITool[]> {
    if (this.toolsCache) return this.toolsCache;
    if (!this.connected) await this.connect();
    const { tools } = await this.client.listTools();
    this.toolsCache = tools.map(mcpToolToOpenAITool);
    return this.toolsCache;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) await this.connect();
    const result = (await this.client.callTool({
      name,
      arguments: args,
    })) as CallToolResult;
    // MCP returns { content: [{ type: 'text', text: '...' }, ...] } for text,
    // or { content: [...], structuredContent?: {...} } for structured output.
    // Newer SDKs also allow a { toolResult: ... } variant. We unwrap to the
    // most useful shape.
    if (result.structuredContent) return result.structuredContent;
    // The new toolResult variant carries a typed result.
    const maybeToolResult = (result as unknown as { toolResult?: unknown })
      .toolResult;
    if (maybeToolResult !== undefined) return maybeToolResult;
    if (!Array.isArray(result.content)) {
      // Fallback: return the raw object.
      return result;
    }
    const text = result.content
      .map((c) => (c && (c as { type?: string }).type === "text"
        ? (c as { text?: string }).text
        : ""))
      .filter(Boolean)
      .join("\n");
    if (!text) return result;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.close();
    } finally {
      this.connected = false;
      this.toolsCache = null;
    }
  }
}
