/**
 * OpenRouter helper.
 *
 * OpenRouter returns a `usage` object on every response (no opt-in parameter -
 * the old `usage: { include: true }` flag is deprecated and does nothing), and
 * that object carries the provider-final `cost`. Forwarding it is what makes an
 * OpenRouter integration exact rather than estimated: MarginFuse cannot know
 * what a gateway charged, because routing, fees and BYOK terms are not visible
 * in a usage event.
 *
 * Two details this helper exists to get right, both of which silently
 * misstate margin when hand-rolled:
 *
 *  1. `prompt_tokens` is the TOTAL input count - cached reads and cache writes
 *     are already inside it. MarginFuse prices inputTokens, cachedInputTokens
 *     and cacheCreationTokens as three separate charges and adds them up, so
 *     passing `prompt_tokens` straight through double-counts every cached
 *     token, at the full uncached rate.
 *  2. `cost` is a JavaScript number, and small ones stringify to exponent
 *     notation ("1.2e-7"), which the API rejects as a decimal string.
 */

import type { TrackParams, Usage } from "./types.js";

/**
 * The fields this helper reads from an OpenRouter `usage` object. Structural on
 * purpose - it accepts the response of the OpenAI SDK pointed at OpenRouter,
 * or a plain fetch, without either side importing the other's types.
 */
export interface OpenRouterUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cost?: number | null;
  prompt_tokens_details?: {
    cached_tokens?: number | null;
    cache_write_tokens?: number | null;
    audio_tokens?: number | null;
  } | null;
}

const int = (n: number | null | undefined): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;

/**
 * OpenRouter credits (1 credit = 1 USD) as a decimal string the API accepts.
 * Fixed-point to nanos precision: `String()` would emit exponent notation for
 * the small costs cheap models produce, and money below a nano cannot be
 * represented at all, so it rounds to "0" rather than pretending otherwise.
 */
function creditsToUsd(cost: number): string {
  const s = cost.toFixed(9);
  const trimmed = s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
  return trimmed === "" || trimmed === "-0" ? "0" : trimmed;
}

/**
 * Map an OpenRouter `usage` object to the MarginFuse fields, ready to spread
 * into track() or return from guard().
 *
 * const r = await openai.chat.completions.create({ model, messages });
 * mf.track({ customerId, feature: "ai_chat", provider: "openrouter", model, ...fromOpenRouter(r.usage) });
 *
 * `costUsd` is omitted when the response carried no cost, which lets the event
 * fall through to MarginFuse's own pricing instead of claiming a $0 charge.
 */
export function fromOpenRouter(
  usage: OpenRouterUsage | null | undefined,
): Pick<TrackParams, "usage"> & { costUsd?: string } {
  const cachedInputTokens = int(usage?.prompt_tokens_details?.cached_tokens);
  const cacheCreationTokens = int(usage?.prompt_tokens_details?.cache_write_tokens);
  // Cached reads and writes are already counted inside prompt_tokens; what is
  // left is what was billed at the full input rate. Clamped at zero so a
  // provider that reports these differently degrades to "no fresh input"
  // rather than a negative charge.
  const inputTokens = Math.max(0, int(usage?.prompt_tokens) - cachedInputTokens - cacheCreationTokens);

  const out: Usage = {};
  if (inputTokens > 0) out.inputTokens = inputTokens;
  const outputTokens = int(usage?.completion_tokens);
  if (outputTokens > 0) out.outputTokens = outputTokens;
  if (cachedInputTokens > 0) out.cachedInputTokens = cachedInputTokens;
  if (cacheCreationTokens > 0) out.cacheCreationTokens = cacheCreationTokens;

  const cost = usage?.cost;
  const hasCost = typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
  return { usage: out, ...(hasCost ? { costUsd: creditsToUsd(cost) } : {}) };
}
