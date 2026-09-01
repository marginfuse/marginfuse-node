/**
 * MarginFuse Node SDK.
 *
 * Reliability contract (spec §5.5, §29.3): this SDK NEVER throws into
 * application code and NEVER blocks a request on MarginFuse availability.
 * decide() fails open to "allow" on any timeout or error; track()/report()
 * retry in the background and surface problems only via options.onError.
 */

import type {
  Acknowledgment,
  DecideParams,
  Decision,
  MarginFuseOptions,
  TrackParams,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.marginfuse.com";
const DEFAULT_TIMEOUT_MS = 1500;
const TRACK_RETRIES = 3;

export class MarginFuse {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly onError: (error: Error, context: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(options: MarginFuseOptions) {
    if (!options.apiKey) throw new Error("MarginFuse: apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onError = options.onError ?? (() => {});
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Pre-request policy check (protection-ready integrations, §13.2).
   * Always resolves. On any failure resolves {action:"allow", degraded:true}.
   */
  async decide(params: DecideParams): Promise<Decision> {
    const failOpen = (reason: string): Decision => ({
      action: "allow",
      model: params.model,
      provider: params.provider,
      degraded: true,
      degradedReason: reason,
    });
    try {
      const res = await this.post("/v1/decisions", params, this.timeoutMs);
      if (!res.ok) {
        this.onError(new Error(`decide: HTTP ${res.status}`), "decide");
        return failOpen(`server responded ${res.status}`);
      }
      const body = (await res.json()) as {
        id: string;
        action: Decision["action"];
        model?: string;
        provider?: string;
        topupContext?: string;
        degraded?: boolean;
        degradedReason?: string;
      };
      return {
        id: body.id,
        action: body.action,
        model: body.model ?? params.model,
        provider: body.provider ?? params.provider,
        ...(body.topupContext !== undefined ? { topupContext: body.topupContext } : {}),
        degraded: body.degraded ?? false,
        ...(body.degradedReason !== undefined ? { degradedReason: body.degradedReason } : {}),
      };
    } catch (err) {
      this.onError(err as Error, "decide");
      return failOpen((err as Error).name === "TimeoutError" ? "timeout" : "unreachable");
    }
  }

  /**
   * Report actual usage after the provider call (monitor-only §13.1 and
   * post-request reconciliation §25.3). Fire-and-forget with retries.
   */
  track(params: TrackParams): void {
    const event = {
      eventId: params.eventId ?? cryptoRandomId(),
      occurredAt: (params.occurredAt ?? new Date()).toISOString(),
      outcome: params.outcome ?? "success",
      ...params,
    };
    this.background(async () => {
      let lastErr: Error | undefined;
      for (let attempt = 0; attempt < TRACK_RETRIES; attempt++) {
        try {
          const res = await this.post("/v1/events", { events: [event] }, 5000);
          if (res.ok) return;
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            // client error won't heal on retry - surface once
            this.onError(new Error(`track: HTTP ${res.status} ${await safeText(res)}`), "track");
            return;
          }
          lastErr = new Error(`track: HTTP ${res.status}`);
        } catch (err) {
          lastErr = err as Error;
        }
        await sleep(250 * 2 ** attempt);
      }
      if (lastErr) this.onError(lastErr, "track");
    });
  }

  /** Awaitable variant of track for jobs/scripts that must not exit early. */
  async trackAndWait(params: TrackParams): Promise<void> {
    this.track(params);
    await this.flush();
  }

  /** Tell MarginFuse what your app actually did with a decision (§25.2). */
  acknowledge(decisionId: string, acknowledgment: Acknowledgment): void {
    this.background(async () => {
      try {
        const res = await this.post(`/v1/decisions/${encodeURIComponent(decisionId)}/ack`, { acknowledgment }, 5000);
        if (!res.ok) this.onError(new Error(`ack: HTTP ${res.status}`), "acknowledge");
      } catch (err) {
        this.onError(err as Error, "acknowledge");
      }
    });
  }

  /**
   * Full protection loop in one wrapper: decide → run your provider call with
   * the resolved model → report usage → acknowledge.
   *
   * const out = await mf.guard(
   *   { customerId, feature: "ai_chat", provider: "openai", model: "gpt-4.1" },
   *   async ({ model }) => {
   *     const r = await openai.chat.completions.create({ model, messages });
   *     return { result: r, usage: { inputTokens: r.usage.prompt_tokens, outputTokens: r.usage.completion_tokens } };
   *   },
   * );
   * if (out.kind === "completed") use(out.result);
   * else handle out.kind === "blocked" | "topup_required" with your own UX.
   */
  async guard<T>(
    params: DecideParams,
    run: (ctx: { model: string; provider: string; decision: Decision }) => Promise<{
      result: T;
      usage: TrackParams["usage"];
      costUsd?: string;
      outcome?: TrackParams["outcome"];
    }>,
  ): Promise<
    | { kind: "completed"; result: T; decision: Decision }
    | { kind: "blocked"; decision: Decision }
    | { kind: "topup_required"; decision: Decision }
  > {
    const decision = await this.decide(params);

    // Enforcement depends on the ACTION alone. Whether we can also report back
    // is a separate concern: a missing id costs an acknowledgment, it must
    // never turn a block into a provider call. (Fail-open is already handled -
    // decide() returns action "allow" whenever it could not reach a verdict.)
    if (decision.action === "block") {
      if (decision.id) this.acknowledge(decision.id, "blocked_before_provider_call");
      return { kind: "blocked", decision };
    }
    if (decision.action === "topup_required") {
      if (decision.id) this.acknowledge(decision.id, "presented_topup");
      return { kind: "topup_required", decision };
    }

    const modelToUse = decision.action === "downgrade" ? decision.model : params.model;
    let outcome: TrackParams["outcome"] = "success";
    try {
      const out = await run({ model: modelToUse, provider: decision.provider, decision });
      this.track({
        customerId: params.customerId,
        ...(params.feature !== undefined ? { feature: params.feature } : {}),
        provider: params.provider,
        model: modelToUse,
        requestedModel: params.model,
        usage: out.usage,
        ...(out.costUsd !== undefined ? { costUsd: out.costUsd } : {}),
        outcome: out.outcome ?? "success",
        ...(decision.id !== undefined ? { decisionId: decision.id } : {}),
      });
      if (decision.id) {
        this.acknowledge(
          decision.id,
          decision.action === "downgrade" ? "used_downgrade_model" : "proceeded_as_requested",
        );
      }
      return { kind: "completed", result: out.result, decision };
    } catch (err) {
      outcome = "provider_error";
      // Provider may still have charged - record the attempt without usage (§15.4);
      // the app can send a corrected event with real usage if it has it.
      this.track({
        customerId: params.customerId,
        ...(params.feature !== undefined ? { feature: params.feature } : {}),
        provider: params.provider,
        model: modelToUse,
        requestedModel: params.model,
        usage: {},
        outcome,
        ...(decision.id !== undefined ? { decisionId: decision.id } : {}),
      });
      if (decision.id) this.acknowledge(decision.id, "proceeded_as_requested");
      throw err; // the app's own error handling owns provider failures
    }
  }

  /** Wait for queued track/ack calls (use before process exit). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private background(fn: () => Promise<void>): void {
    const p = fn().finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "user-agent": "marginfuse-node/0.1.0",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

/**
 * A v4 UUID from whatever the runtime offers, degrading rather than throwing.
 *
 * `globalThis.crypto` only became a global in Node 19, so on Node 18 (which
 * this package supports) a bare `crypto.randomUUID()` is a ReferenceError, and
 * it would be thrown synchronously out of track() into application code. That
 * is the one thing this SDK must never do, so the id source falls back instead.
 *
 * `node:crypto` is deliberately not imported: this runs on Workers and other
 * edge runtimes where that module does not exist, and an id is an idempotency
 * key rather than a secret, so Math.random is an acceptable last resort.
 */
function cryptoRandomId(): string {
  return `evt_${uuidV4()}`;
}

/** Structural, so no DOM lib is needed and no runtime's typings leak in. */
interface WebCryptoLike {
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T;
}

function uuidV4(): string {
  const webcrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (typeof webcrypto?.randomUUID === "function") return webcrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof webcrypto?.getRandomValues === "function") {
    webcrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variant 10

  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
  return (
    `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-` +
    `${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
