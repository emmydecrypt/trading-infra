import { describe, it, expect } from "vitest";
import { QwenClient } from "../src/qwen.js";
import { makeCompletion } from "./_helpers.js";

describe("QwenClient", () => {
  it("posts to {baseUrl}/chat/completions with bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: input.toString(), init: init! });
      return new Response(JSON.stringify(makeCompletion({ content: "ok" })), {
        status: 200,
      });
    };
    const c = new QwenClient({
      baseUrl: "https://example.test/v1",
      apiKey: "sk-xyz",
      model: "qwen-plus",
      fetchImpl,
    });
    const out = await c.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: { name: "ping", parameters: { type: "object" } },
        },
      ],
    });
    expect(out.choices[0].message.content).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://example.test/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-xyz");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe("qwen-plus");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.tools[0].function.name).toBe("ping");
  });

  it("trims trailing slashes from baseUrl", async () => {
    let urlSeen = "";
    const fetchImpl: typeof fetch = async (input) => {
      urlSeen = input.toString();
      return new Response(JSON.stringify(makeCompletion({ content: "ok" })), { status: 200 });
    };
    const c = new QwenClient({
      baseUrl: "https://example.test/v1///",
      apiKey: "k",
      model: "m",
      fetchImpl,
    });
    await c.chat({ messages: [{ role: "user", content: "x" }] });
    expect(urlSeen).toBe("https://example.test/v1/chat/completions");
  });

  it("surfaces non-2xx as error", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
    const c = new QwenClient({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      fetchImpl,
    });
    await expect(c.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(
      /429/
    );
  });
});
