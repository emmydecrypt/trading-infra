/**
 * Qwen (DashScope OpenAI-compatible) chat completions client.
 *
 * Qwen's `compatible-mode` endpoint is OpenAI-compatible:
 *   POST {baseUrl}/chat/completions
 *   Authorization: Bearer $QWEN_API_KEY
 *
 * We use global `fetch` (Node 20+) — no SDK dependency, fewer supply-chain
 * risks. Tests inject a mocked `fetch` via the `fetchImpl` option.
 */
import type { OpenAITool } from "./mcp-client.js";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string | null;
  /** For assistant messages that triggered tool calls. */
  tool_calls?: ToolCall[];
  /** For tool result messages. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

export interface ChatCompletion {
  id: string;
  model: string;
  choices: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface QwenClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Inject for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Default timeout per request in ms. */
  timeoutMs?: number;
}

export interface CreateChatParams {
  messages: ChatMessage[];
  tools?: OpenAITool[];
  /** Defaults to "auto" — let the model choose. */
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
}

export class QwenClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: QwenClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async chat(params: CreateChatParams): Promise<ChatCompletion> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: params.messages,
    };
    if (params.tools && params.tools.length > 0) body.tools = params.tools;
    if (params.tool_choice) body.tool_choice = params.tool_choice;
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.max_tokens !== undefined) body.max_tokens = params.max_tokens;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Qwen API ${res.status} ${res.statusText}: ${text.slice(0, 500)}`
      );
    }
    return (await res.json()) as ChatCompletion;
  }
}
