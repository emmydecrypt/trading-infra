import { describe, it, expect } from "vitest";
import { parseAction, ActionParseError } from "../src/action.js";

describe("parseAction", () => {
  it("parses clean JSON", () => {
    const a = parseAction(
      '{"side":"buy","symbol":"BTCUSDT","size_pct":25,"reasoning":"rsi oversold"}'
    );
    expect(a).toEqual({
      side: "buy",
      symbol: "BTCUSDT",
      size_pct: 25,
      reasoning: "rsi oversold",
    });
  });

  it("parses JSON inside a markdown code fence", () => {
    const a = parseAction(
      'Here you go:\n```json\n{"side":"sell","symbol":"ETHUSDT","size_pct":50,"reasoning":"exit"}\n```\nThanks!'
    );
    expect(a.side).toBe("sell");
    expect(a.symbol).toBe("ETHUSDT");
    expect(a.size_pct).toBe(50);
  });

  it("parses JSON embedded in prose", () => {
    const a = parseAction(
      'Sure, my decision is {"side":"hold","symbol":"BTCUSDT","size_pct":0,"reasoning":"range-bound"} for now.'
    );
    expect(a.side).toBe("hold");
    expect(a.size_pct).toBe(0);
  });

  it("rejects empty content", () => {
    expect(() => parseAction("")).toThrow(ActionParseError);
    expect(() => parseAction(null)).toThrow(ActionParseError);
    expect(() => parseAction("   \n  ")).toThrow(ActionParseError);
  });

  it("rejects invalid side / size_pct", () => {
    expect(() =>
      parseAction('{"side":"short","symbol":"X","size_pct":10,"reasoning":"r"}')
    ).toThrow(/side/);
    expect(() =>
      parseAction('{"side":"buy","symbol":"X","size_pct":150,"reasoning":"r"}')
    ).toThrow(/size_pct/);
    expect(() =>
      parseAction('{"side":"buy","symbol":"X","size_pct":-1,"reasoning":"r"}')
    ).toThrow(/size_pct/);
  });

  it("rejects content with no JSON", () => {
    expect(() => parseAction("I'm not sure what to do.")).toThrow(
      ActionParseError
    );
  });
});
