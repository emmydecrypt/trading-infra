import vm from "node:vm";
import type { Action, MarketDataPoint, Portfolio, StrategyFn } from "../types.js";

export interface SandboxOptions {
  /** Wall-clock budget per call in milliseconds. */
  timeoutMs?: number;
}

export interface SandboxResult {
  ok: boolean;
  strategy: StrategyFn | null;
  error: string | null;
}

/**
 * Compile user-submitted TypeScript-ish code inside a Node `vm` context.
 *
 * Why vm?
 *  - We want isolation from the host process. The agent cannot reach
 *    `require`, `process`, `fetch`, etc.
 *  - We get a hard 1-second wall-clock budget per call (`timeout`).
 *  - We surface errors and timeouts to the harness so they are recorded
 *    as run failures with a reason, not thrown to the caller.
 *
 * The agent code is plain JavaScript; we strip TypeScript type annotations
 * via a small regex pass for the common cases. Submissions are expected
 * to be small (<2KB) so a heavier parser is not justified here.
 */
export function compileAgent(code: string, opts: SandboxOptions = {}): SandboxResult {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const stripped = stripTypeAnnotations(code);

  const script = new vm.Script(
    `${stripped}\n;globalThis.__strategy = strategy;`,
    { filename: "agent.ts" },
  );

  const ctx: Record<string, unknown> = {
    Math,
    JSON,
    Date,
    Array,
    Object,
    Number,
    String,
    Boolean,
    globalThis: undefined,
  };
  ctx.globalThis = ctx;
  const context = vm.createContext(ctx);

  try {
    script.runInContext(context, { timeout: timeoutMs });
  } catch (err) {
    return { ok: false, strategy: null, error: errorMessage(err) };
  }

  const strategy = (ctx as Record<string, unknown>).__strategy;
  if (typeof strategy !== "function") {
    return { ok: false, strategy: null, error: "agent must export a function `strategy`" };
  }
  return { ok: true, strategy: strategy as StrategyFn, error: null };
}

/** Invoke a strategy with a hard wall-clock budget. */
export function callStrategy(
  strategy: StrategyFn,
  marketData: MarketDataPoint,
  portfolio: Portfolio,
  opts: SandboxOptions = {},
): { ok: true; action: Action } | { ok: false; error: string } {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const wrapped = `(${strategy.toString()})(JSON.parse(${JSON.stringify(JSON.stringify(marketData))}), JSON.parse(${JSON.stringify(JSON.stringify(portfolio))}))`;
  try {
    const script = new vm.Script(wrapped, { filename: "agent-call.js" });
    const ctx = vm.createContext({});
    const result = script.runInContext(ctx, { timeout: timeoutMs });
    const validated = validateAction(result);
    if (!validated.ok) return validated;
    return { ok: true, action: validated.action };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function validateAction(value: unknown): { ok: true; action: Action } | { ok: false; error: string } {
  if (value === null || typeof value !== "object") {
    return { ok: false, error: "strategy must return an object" };
  }
  const v = value as Record<string, unknown>;
  const side = v.side;
  if (side !== "buy" && side !== "sell" && side !== "hold") {
    return { ok: false, error: `invalid action.side: ${String(side)}` };
  }
  const symbol = typeof v.symbol === "string" ? v.symbol : "BTCUSDT";
  // `hold` does not require size_pct (it would be meaningless).
  if (side === "hold") {
    return { ok: true, action: { side, symbol, size_pct: 0 } };
  }
  const sizePct = Number(v.size_pct);
  if (!Number.isFinite(sizePct) || sizePct < 0 || sizePct > 1) {
    return { ok: false, error: `invalid action.size_pct: ${String(v.size_pct)}` };
  }
  return { ok: true, action: { side, symbol, size_pct: sizePct } };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /timed out/i.test(err.message)) {
      return "agent call exceeded timeout";
    }
    return err.message;
  }
  return String(err);
}

/**
 * Strip TypeScript type annotations from the simple cases our agent SDK
 * requires. Handles:
 *   - parameter types: `(m: MarketData, p: Portfolio) =>`
 *   - return types:    `: Action {`
 *   - type aliases and interfaces declared with `interface`/`type`
 *
 * Anything more exotic (generics, conditional types) should be removed
 * from agent submissions by the author — the README documents this.
 */
export function stripTypeAnnotations(code: string): string {
  let out = code;
  // Remove `interface Foo { ... }` blocks (single line or multiline).
  out = out.replace(/^\s*export\s+(default\s+)?/gm, "");
  out = out.replace(/\binterface\s+\w+(?:\s*<[^>]+>)?\s*(?:extends[^{]*)?\{[\s\S]*?\}\s*/g, "");
  // Remove top-level `type X = ...;` declarations.
  out = out.replace(/\btype\s+\w+(?:\s*<[^>]+>)?\s*=\s*[^;\n]+;?/g, "");
  // Remove return-type annotation after `)`:  `(m, p): Action {` or `(m, p): Action =>`.
  // TypeName is a bare identifier (no dots/brackets/quotes) so it cannot
  // swallow object-literal syntax like `{ side: 'buy' }`.
  out = out.replace(/\)\s*:\s*[A-Za-z_$][\w$]*(?=\s*[{=>])/g, ")");
  // Remove parameter annotations in arg lists: `name: TypeName` where
  // TypeName is a bare identifier. The `(?=[,)])` lookahead keeps us
  // inside a parameter list, and the strict identifier char class keeps
  // us out of object literals and string literals.
  out = out.replace(/(\w)\s*:\s*[A-Za-z_$][\w$]*(?=[,)])/g, "$1");
  // Remove `as TypeName` assertions.
  out = out.replace(/\s+as\s+[A-Za-z_$][\w$]*/g, "");
  return out;
}