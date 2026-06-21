/**
 * Action schema + parser.
 *
 * The model is asked to return JSON: { side, symbol, size_pct, reasoning }.
 * We also accept the common failure mode where the model wraps the JSON in
 * a markdown code fence, and try a couple of last-ditch extractions.
 */
import { z } from "zod";

export const SideEnum = z.enum(["buy", "sell", "hold"]);
export type Side = z.infer<typeof SideEnum>;

export const ActionSchema = z.object({
  side: SideEnum,
  symbol: z.string().min(1).max(32),
  size_pct: z.number().min(0).max(100),
  reasoning: z.string().min(1).max(500),
});
export type Action = z.infer<typeof ActionSchema>;

export class ActionParseError extends Error {
  constructor(
    message: string,
    public readonly raw: string
  ) {
    super(message);
    this.name = "ActionParseError";
  }
}

/**
 * Parse the assistant's final message content into an Action.
 * Tolerates: code-fenced JSON, leading prose, trailing prose, single quotes.
 */
export function parseAction(content: string | null | undefined): Action {
  if (!content || !content.trim()) {
    throw new ActionParseError("Empty assistant content", content ?? "");
  }
  const raw = content.trim();

  // 1) Try direct JSON parse.
  const direct = tryJson(raw);
  if (direct) return validate(direct, raw);

  // 2) Strip code fences ```json ... ``` or ``` ... ```.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fenced) {
    const inside = tryJson(fenced[1]);
    if (inside) return validate(inside, raw);
  }

  // 3) First {...} block.
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = raw.slice(firstBrace, lastBrace + 1);
    const inside = tryJson(slice);
    if (inside) return validate(inside, raw);
  }

  throw new ActionParseError(
    "Assistant content is not parseable JSON action",
    raw
  );
}

function tryJson(s: string): Record<string, unknown> | null {
  // Try strict first.
  try {
    const v = JSON.parse(s);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  // Try a single-quote fix.
  const fixed = s
    .replace(/'/g, '"')
    .replace(/(\w)"(\w)/g, "$1'$2")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    const v = JSON.parse(fixed);
    if (v && typeof v === "object" && !Array.isArray(v))
      return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  return null;
}

function validate(parsed: Record<string, unknown>, raw: string): Action {
  const result = ActionSchema.safeParse(parsed);
  if (!result.success) {
    throw new ActionParseError(
      `Action validation failed: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      raw
    );
  }
  return result.data;
}
