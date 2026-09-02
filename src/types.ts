/**
 * Wire types for the MarginFuse SDK. Deliberately: there is NO field for
 * prompt text, responses, or documents - the SDK cannot leak what it cannot
 * carry.
 */

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  images?: number;
  audioSeconds?: number;
}

export type Outcome = "success" | "provider_error" | "app_cancelled" | "timeout";

export interface TrackParams {
  /** Your unique id for this call; reusing one is safe (idempotent). Auto-generated if omitted. */
  eventId?: string;
  /** Your application's id for the end customer (or their Stripe customer id). */
  customerId: string;
  /** Stable feature key, e.g. "ai_chat". */
  feature?: string;
  provider: "openai" | "anthropic" | "openrouter" | (string & {});
  model: string;
  requestedModel?: string;
  usage: Usage;
  /** Actual cost if your provider response includes it (decimal string, e.g. "0.0142"). */
  costUsd?: string;
  occurredAt?: Date;
  outcome?: Outcome;
  /** Link to a prior decide() result for reconciliation. */
  decisionId?: string;
  retryOfEventId?: string;
  correctsEventId?: string;
}

export interface DecideParams {
  customerId: string;
  feature?: string;
  provider: "openai" | "anthropic" | "openrouter" | (string & {});
  model: string;
  /** Optional expected usage for a better pre-request cost estimate. */
  expectedUsage?: Usage;
}

export type DecisionAction = "allow" | "downgrade" | "topup_required" | "block";

export interface Decision {
  /** Present when the server produced the decision; absent on fail-open. */
  id?: string;
  action: DecisionAction;
  /** The model your app should use for this request (downgrades change it). */
  model: string;
  provider: string;
  /** For topup_required: pass-through context configured in the policy. */
  topupContext?: string;
  /** True when MarginFuse could not be reached / evaluated - request allowed (fail-open). */
  degraded: boolean;
  degradedReason?: string;
}

export type Acknowledgment =
  | "proceeded_as_requested"
  | "used_downgrade_model"
  | "presented_topup"
  | "blocked_before_provider_call"
  | "failed_to_apply";

export interface MarginFuseOptions {
  apiKey: string;
  /** Default https://api.marginfuse.com - point at your own deployment in dev. */
  baseUrl?: string;
  /** Decision timeout. On expiry the SDK fails open (allow). Default 1500 ms. */
  timeoutMs?: number;
  /** Called with transport errors the SDK swallowed (it never throws into your app). */
  onError?: (error: Error, context: string) => void;
  fetch?: typeof fetch;
}
