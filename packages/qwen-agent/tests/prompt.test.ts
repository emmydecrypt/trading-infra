import { describe, it, expect } from "vitest";
import { buildUserPrompt, SYSTEM_PROMPT } from "../src/prompt.js";
import { samplePortfolio, sampleSnapshot } from "./_helpers.js";

describe("buildUserPrompt", () => {
  it("includes symbol, portfolio fields, and last candles", () => {
    const prompt = buildUserPrompt(samplePortfolio(), sampleSnapshot());
    expect(prompt).toContain("Symbol: BTCUSDT");
    expect(prompt).toContain("Cash:");
    expect(prompt).toContain("BTCUSDT:"); // position
    expect(prompt).toContain("Equity:");
    expect(prompt).toContain("Realized PnL:");
    expect(prompt).toContain("Interval: 1m");
    expect(prompt).toContain("Orderbook");
    expect(prompt).toContain("Spread (bps):");
    expect(prompt).toContain("Last close:");
  });

  it("renders zero positions cleanly", () => {
    const prompt = buildUserPrompt(
      { cash: 100, positions: [], equity: 100, realizedPnl: 0 },
      sampleSnapshot()
    );
    expect(prompt).toContain("Positions: (none)");
  });

  it("includes the system contract instructions in SYSTEM_PROMPT", () => {
    expect(SYSTEM_PROMPT).toContain("size_pct");
    expect(SYSTEM_PROMPT).toContain("get_signal");
    expect(SYSTEM_PROMPT).toMatch(/"buy"|"sell"|"hold"/);
  });

  it("truncates to 5 last candles in the user prompt", () => {
    const prompt = buildUserPrompt(samplePortfolio(), sampleSnapshot());
    // Header line lists "last 5 of 60 candles"
    expect(prompt).toMatch(/last 5 of 60 candles/);
  });
});
