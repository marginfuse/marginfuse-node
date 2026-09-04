/**
 * MarginFuse Node SDK.
 *
 * Reliability contract: this SDK NEVER throws into
 * application code and NEVER blocks a request on MarginFuse availability.
 * decide() fails open to "allow" on any timeout or error; track()/report()
 * retry in the background and surface problems only via options.onError.
 */

import type {
  Acknowledgment,
  DecideParams,
  Decision,
  IdentifyParams,
  IdentifyResult,
  MarginFuseOptions,
  TrackParams,
  Usage,
} from "./types.js";

import { VERSION } from "./version.js";

const DEFAULT_BASE_URL = "https://api.marginfuse.com";
const DEFAULT_TIMEOUT_MS = 1500;
/** Everything that is not a decision runs in the background, so it can wait longer. */
const BACKGROUND_TIMEOUT_MS = 5000;

/** The server's ceiling for one /v1/events body; sending more is a 422 for the whole batch. */
const MAX_BATCH_EVENTS = 500;
const DEFAULT_BATCH_INTERVAL_MS = 200;
const DEFAULT_MAX_QUEUED_EVENTS = 10_000;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;

/**
 * The retry schedule for a batch.
 *
 * The old one (250 ms, 500 ms, 1000 ms) gave up inside two seconds, which is
 * shorter than any rate-limit window it could hit: a limited project lost every
 * event it produced AND tripled the flood that limited it in the first place.
 * These numbers span a full window instead - eight attempts, doubling from
 * 500 ms up to a 30 s ceiling, inside a 90 s wall-clock budget so that a
 * Retry-After of a whole minute still leaves room for one more attempt.
 *
 * Half of each wait is fixed and half is random (equal jitter): the fixed half
 * keeps the budget honest, the random half stops N processes that were limited
 * by the same window from retrying in lockstep and re-creating it.
 */
const TRACK_ATTEMPTS = 8;
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 30_000;
const RETRY_BUDGET_MS = 90_000;
/** A server may ask for longer than we are willing to hold events in memory. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Exactly what /v1/events accepts, and nothing else.
 *
 * The API validates strictly, but this is the copy that matters here: the
 * request body is assembled field by field from this shape, so a caller's extra
 * keys have nowhere to go (§5.6, §33).
 */
interface WireEvent {
  eventId: string;
  customerId: string;
  plan?: string;
  feature?: string;
  provider: string;
  model: string;
  requestedModel?: string;
  usage: Usage;
  costUsd?: string;
  occurredAt: string;
  outcome: string;
  decisionId?: string;
  retryOfEventId?: string;
  correctsEventId?: string;
}

/**
 * One unit of background work, in the order the application produced it.
 *
 * Events coalesce into a batch; anything else is a single request. The queue is
 * strictly ordered because guard() reports usage and then acknowledges the
 * decision, and an ack that overtook its own usage event would describe a call
 * MarginFuse has not been told about yet. So an open batch holds the queue for
 * at most batchIntervalMs rather than being overtaken by what belongs behind it.
 */
type EventBatch = { kind: "events"; events: WireEvent[]; sealed: boolean };
type Job = EventBatch | { kind: "request"; send: () => Promise<void> };

export class MarginFuse {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly onError: (error: Error, context: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly batchIntervalMs: number;
  private readonly maxQueuedEvents: number;
  private readonly maxConcurrentRequests: number;

  private readonly pending = new Set<Promise<unknown>>();
  private readonly jobs: Job[] = [];
  private openBatch: EventBatch | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private queuedEvents = 0;
  private inFlight = 0;
  private overflowReported = false;

  constructor(options: MarginFuseOptions) {
    if (!options.apiKey) throw new Error("MarginFuse: apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onError = options.onError ?? (() => {});
    this.fetchImpl = options.fetch ?? fetch;
    // Clamped, because a zero here would wedge the queue rather than tune it.
    this.batchIntervalMs = Math.max(0, options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS);
    this.maxQueuedEvents = Math.max(1, options.maxQueuedEvents ?? DEFAULT_MAX_QUEUED_EVENTS);
    this.maxConcurrentRequests = Math.max(
      1,
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    );
  }

  /**
   * Asks whether the next provider call should run.
   * Always resolves. On any failure resolves {action:"allow", degraded:true},
   * because MarginFuse being unreachable must never become your outage.
   */
  async decide(params: DecideParams): Promise<Decision> {
    const failOpen = (reason: string): Decision => ({
      action: "allow",
      model: params.model,
      provider: params.provider,
      degraded: true,
      degradedReason: reason,
    });
    // Named field by field, like every other body here (§5.6, §33).
    const body = {
      customerId: params.customerId,
      ...(params.plan !== undefined ? { plan: params.plan } : {}),
      ...(params.feature !== undefined ? { feature: params.feature } : {}),
      provider: params.provider,
      model: params.model,
      ...(params.expectedUsage !== undefined ? { expectedUsage: wireUsage(params.expectedUsage) } : {}),
    };
    try {
      const res = await this.post("/v1/decisions", body, this.timeoutMs);
      if (!res.ok) {
        discard(res);
        this.report(new Error(`decide: HTTP ${res.status}`), "decide");
        return failOpen(`server responded ${res.status}`);
      }
      const decoded = (await res.json()) as {
        id: string;
        action: Decision["action"];
        model?: string;
        provider?: string;
        topupContext?: string;
        degraded?: boolean;
        degradedReason?: string;
      };
      return {
        id: decoded.id,
        action: decoded.action,
        model: decoded.model ?? params.model,
        provider: decoded.provider ?? params.provider,
        ...(decoded.topupContext !== undefined ? { topupContext: decoded.topupContext } : {}),
        degraded: decoded.degraded ?? false,
        ...(decoded.degradedReason !== undefined ? { degradedReason: decoded.degradedReason } : {}),
      };
    } catch (err) {
      const error = toError(err);
      this.report(error, "decide");
      return failOpen(error.name === "TimeoutError" ? "timeout" : "unreachable");
    }
  }

  /**
   * Reports what a provider call actually consumed, after it happened.
   * Returns immediately and retries in the background. Call flush() before
   * the process exits, or the last events go with it.
   */
  track(params: TrackParams): void {
    // EVERY field is named. `...params` would put whatever the caller happened
    // to be carrying on the wire - TypeScript's excess-property check fires on
    // a fresh object literal and never on a variable, which is how real code
    // assembles parameters - and the promise this SDK makes is that the wire
    // format cannot express prompt or response content at all (§5.6, §33).
    // Naming the fields is what makes that true of the bytes and not just of
    // the type.
    //
    // It is also why `eventId` is correct now: a spread put a key that was
    // present-but-undefined (`eventId: maybeId`) over the generated default, so
    // the event went out with none, the API answered 422, and the retry loop
    // dropped it silently. `??` reads through an explicit undefined.
    const event: WireEvent = {
      eventId: params.eventId ?? cryptoRandomId(),
      customerId: params.customerId,
      ...(params.plan !== undefined ? { plan: params.plan } : {}),
      ...(params.feature !== undefined ? { feature: params.feature } : {}),
      provider: params.provider,
      model: params.model,
      ...(params.requestedModel !== undefined ? { requestedModel: params.requestedModel } : {}),
      usage: wireUsage(params.usage),
      ...(params.costUsd !== undefined ? { costUsd: params.costUsd } : {}),
      occurredAt: (params.occurredAt ?? new Date()).toISOString(),
      outcome: params.outcome ?? "success",
      ...(params.decisionId !== undefined ? { decisionId: params.decisionId } : {}),
      ...(params.retryOfEventId !== undefined ? { retryOfEventId: params.retryOfEventId } : {}),
      ...(params.correctsEventId !== undefined ? { correctsEventId: params.correctsEventId } : {}),
    };
    this.enqueueEvent(event);
  }

  /**
   * Tells MarginFuse who a customer is and what plan they are on.
   *
   * `plan` is the key of a plan you declared in MarginFuse Settings. From its
   * price MarginFuse derives the customer's revenue per period, which is what
   * makes margin per customer and margin policies work with no revenue source
   * connected. Those figures are labeled as a declared price everywhere they
   * appear, because nobody confirmed collection.
   *
   * Safe to call on every sign-in: sending the plan the customer is already on
   * changes nothing. Sending a different one ends the current cycle at that
   * moment and prorates what accrued.
   *
   * Unlike track(), this awaits and reports failure, because "I could not
   * record what this customer pays" has no safe default - a wrong plan is a
   * wrong margin. It still never throws: the failure comes back as
   * `{ ok: false }` with a reason, and onError is called.
   */
  async identify(params: IdentifyParams): Promise<
    { ok: true; result: IdentifyResult } | { ok: false; error: string }
  > {
    const body = {
      customerId: params.customerId,
      ...(params.plan !== undefined ? { plan: params.plan } : {}),
      ...(params.clearPlan !== undefined ? { clearPlan: params.clearPlan } : {}),
      ...(params.periodStart !== undefined ? { periodStart: params.periodStart.toISOString() } : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.email !== undefined ? { email: params.email } : {}),
      ...(params.metadata !== undefined ? { metadata: params.metadata } : {}),
    };
    try {
      const res = await this.post("/v1/identify", body, BACKGROUND_TIMEOUT_MS);
      if (!res.ok) {
        const detail = await safeText(res);
        const err = new Error(`identify: HTTP ${res.status} ${detail}`);
        this.report(err, "identify");
        return { ok: false, error: err.message };
      }
      return { ok: true, result: (await res.json()) as IdentifyResult };
    } catch (err) {
      const error = toError(err);
      this.report(error, "identify");
      return { ok: false, error: error.message };
    }
  }

  /** Awaitable variant of track for jobs/scripts that must not exit early. */
  async trackAndWait(params: TrackParams): Promise<void> {
    this.track(params);
    await this.flush();
  }

  /** Tells MarginFuse what your application did with a decision. */
  acknowledge(decisionId: string, acknowledgment: Acknowledgment): void {
    this.enqueueRequest(async () => {
      try {
        const res = await this.post(
          `/v1/decisions/${encodeURIComponent(decisionId)}/ack`,
          { acknowledgment },
          BACKGROUND_TIMEOUT_MS,
        );
        if (!res.ok) {
          discard(res);
          this.report(new Error(`ack: HTTP ${res.status}`), "acknowledge");
        }
      } catch (err) {
        this.report(toError(err), "acknowledge");
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
    // The provider that RAN, which is not always the one that was asked for: a
    // downgrade may cross vendors, and the callback is handed decision.provider
    // for exactly that reason. Reporting params.provider here billed the call
    // to the wrong catalogue - the run happened on one vendor and the cost was
    // priced from another's list.
    const providerUsed = decision.provider;
    // A downgrade that the provider then failed on is still a downgrade that
    // was applied, so both paths report the same thing: what we actually did.
    const applied: Acknowledgment =
      decision.action === "downgrade" ? "used_downgrade_model" : "proceeded_as_requested";
    let outcome: TrackParams["outcome"] = "success";
    try {
      const out = await run({ model: modelToUse, provider: providerUsed, decision });
      this.track({
        customerId: params.customerId,
        ...(params.plan !== undefined ? { plan: params.plan } : {}),
        ...(params.feature !== undefined ? { feature: params.feature } : {}),
        provider: providerUsed,
        model: modelToUse,
        requestedModel: params.model,
        usage: out.usage,
        ...(out.costUsd !== undefined ? { costUsd: out.costUsd } : {}),
        outcome: out.outcome ?? "success",
        ...(decision.id !== undefined ? { decisionId: decision.id } : {}),
      });
      if (decision.id) this.acknowledge(decision.id, applied);
      return { kind: "completed", result: out.result, decision };
    } catch (err) {
      outcome = "provider_error";
      // The provider may still have charged for the attempt, so record it
      // without usage. The application can send a corrected event later if
      // it learns the real numbers.
      this.track({
        customerId: params.customerId,
        ...(params.plan !== undefined ? { plan: params.plan } : {}),
        ...(params.feature !== undefined ? { feature: params.feature } : {}),
        provider: providerUsed,
        model: modelToUse,
        requestedModel: params.model,
        usage: {},
        outcome,
        ...(decision.id !== undefined ? { decisionId: decision.id } : {}),
      });
      if (decision.id) this.acknowledge(decision.id, applied);
      throw err; // the app's own error handling owns provider failures
    }
  }

  /**
   * Wait for queued track/ack calls (use before process exit).
   *
   * Deterministic: an event still waiting for its batch to close, and a batch
   * still waiting for a request slot, are not promises yet, so one pass over
   * the in-flight set would miss them. Seal, start what can start, wait, and
   * repeat until both the queue and the in-flight set are empty. During a
   * MarginFuse outage this is as long as the retry budget above, because the
   * alternative to waiting is losing the events.
   */
  async flush(): Promise<void> {
    do {
      this.seal();
      this.pump();
      await Promise.allSettled([...this.pending]);
    } while (this.jobs.length > 0 || this.pending.size > 0);
  }

  /**
   * Buffers one event, and bounds what that buffer can cost.
   *
   * Every track() used to be its own HTTP request carrying exactly one event,
   * with nothing bounding how many could be in flight at once. Under load that
   * is one request per AI call, and during a MarginFuse outage the set of
   * unfinished ones grew without limit inside the customer's process.
   */
  private enqueueEvent(event: WireEvent): void {
    if (this.queuedEvents >= this.maxQueuedEvents) {
      // Drop policy, stated rather than emergent: the NEWEST event is the one
      // refused. Everything already queued is mid-retry and may be seconds from
      // landing, so evicting it to make room would trade events that are nearly
      // saved for events that are not saved yet. Reported once per episode, not
      // once per event, because the point of a bound is to stay quiet.
      if (!this.overflowReported) {
        this.overflowReported = true;
        this.report(
          new Error(
            `track: event dropped, ${this.maxQueuedEvents} already queued (maxQueuedEvents) - ` +
              "MarginFuse is not keeping up and this process is not going to grow to compensate",
          ),
          "track",
        );
      }
      return;
    }
    this.queuedEvents++;

    let batch = this.openBatch;
    if (!batch) {
      batch = { kind: "events", events: [], sealed: false };
      this.openBatch = batch;
      this.jobs.push(batch);
    }
    batch.events.push(event);

    if (batch.events.length >= MAX_BATCH_EVENTS) {
      this.seal(); // the server's ceiling, not a tuning choice
      return;
    }
    if (this.batchTimer === undefined) {
      // Timed from the batch's FIRST event, so no event waits longer than the
      // interval no matter how busy the process gets after it.
      this.batchTimer = setTimeout(() => {
        this.batchTimer = undefined;
        this.seal();
      }, this.batchIntervalMs);
    }
    this.pump();
  }

  private enqueueRequest(send: () => Promise<void>): void {
    this.jobs.push({ kind: "request", send });
    this.pump();
  }

  /** Closes the open batch, releasing the queue behind it. */
  private seal(): void {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    if (this.openBatch) {
      this.openBatch.sealed = true;
      this.openBatch = undefined;
    }
    this.pump();
  }

  /** Starts as much queued work as the concurrency cap allows, in order. */
  private pump(): void {
    while (this.inFlight < this.maxConcurrentRequests) {
      const next = this.jobs[0];
      if (!next) return;
      // An open batch holds the line instead of letting the ack behind it
      // overtake the usage event it refers to. seal() releases it.
      if (next.kind === "events" && !next.sealed) return;
      this.jobs.shift();
      this.inFlight++;
      this.background(async () => {
        try {
          if (next.kind === "events") await this.sendEvents(next.events);
          else await next.send();
        } finally {
          if (next.kind === "events") this.releaseQueued(next.events.length);
          this.inFlight--;
          this.pump();
        }
      });
    }
  }

  private releaseQueued(count: number): void {
    this.queuedEvents -= count;
    if (this.queuedEvents < this.maxQueuedEvents) this.overflowReported = false;
  }

  /**
   * Sends one batch, retrying on anything that can heal.
   *
   * Resending the whole batch is safe after a partial failure: ingestion is
   * idempotent per eventId, so an event that already landed is answered
   * "duplicate" and never counted twice (§14.1).
   */
  private async sendEvents(events: WireEvent[]): Promise<void> {
    const deadline = Date.now() + RETRY_BUDGET_MS;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < TRACK_ATTEMPTS; attempt++) {
      let asked: number | undefined;
      try {
        const res = await this.post("/v1/events", { events }, BACKGROUND_TIMEOUT_MS);
        if (res.ok) return;
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          // client error won't heal on retry - surface once
          this.report(new Error(`track: HTTP ${res.status} ${await safeText(res)}`), "track");
          return;
        }
        lastErr = new Error(`track: HTTP ${res.status}`);
        asked = retryAfterFrom(res);
        discard(res);
      } catch (err) {
        lastErr = toError(err);
      }
      // A server that says how long to wait knows better than our schedule.
      const delay = asked ?? backoffDelay(attempt);
      if (attempt === TRACK_ATTEMPTS - 1 || Date.now() + delay >= deadline) break;
      await sleep(delay);
    }
    if (lastErr) this.report(lastErr, "track");
  }

  /**
   * Runs background work so that it can never reject.
   *
   * A rejected promise nobody handles terminates a Node process under the
   * default settings, and these promises are only awaited if the application
   * happens to call flush(). onError is the application's own callback, called
   * from in here, so a callback that throws used to take the host process down
   * from inside the SDK whose whole contract is that it does not (§5.5).
   */
  private background(fn: () => Promise<void>): void {
    let started: Promise<void>;
    try {
      started = fn();
    } catch (err) {
      started = Promise.reject(toError(err));
    }
    const p = started
      .catch((err: unknown) => this.report(toError(err), "internal"))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** onError, defensively: the application's error handler is allowed to be bad. */
  private report(error: Error, context: string): void {
    try {
      this.onError(error, context);
    } catch {
      // Swallowed on purpose. An exception raised by the caller's own callback
      // is still an exception raised inside MarginFuse, and this SDK does not
      // become the reason an application falls over (§5.5).
    }
  }

  private post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "user-agent": `marginfuse-node/${VERSION}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}

/**
 * Usage, copied field by field for the same reason the event is: `Usage` is an
 * interface, so a variable carrying extra keys satisfies it silently, and
 * `usage: params.usage` would forward them (§5.6, §33).
 */
function wireUsage(usage: Usage | undefined): Usage {
  if (!usage) return {};
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    ...(usage.images !== undefined ? { images: usage.images } : {}),
    ...(usage.audioSeconds !== undefined ? { audioSeconds: usage.audioSeconds } : {}),
  };
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

/** Equal jitter, capped: see the retry constants for why both halves exist. */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function retryAfterFrom(res: Response): number | undefined {
  try {
    return parseRetryAfter(res.headers.get("retry-after"));
  } catch {
    // A fetch implementation without real headers is not worth an exception.
    return undefined;
  }
}

/**
 * Retry-After, in milliseconds, or undefined when the server did not say.
 *
 * Both forms in RFC 9110 are accepted, because both are seen in the wild:
 * delta-seconds from application limiters, an HTTP-date from proxies. Capped,
 * since a server may ask for longer than we are willing to hold events for, and
 * floored at zero so a stale date does not become a negative wait.
 *
 * Exported for its tests only; index.ts does not re-export it.
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value === "") return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
}

/** Anything can be thrown in JavaScript; onError is typed to receive an Error. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Releases the connection a response we are not going to read is still holding.
 *
 * An unread body keeps its socket out of the pool until the garbage collector
 * gets to it, and a retry schedule that now spans a minute would otherwise hold
 * one per attempt, per batch, for that whole minute.
 */
function discard(res: Response): void {
  try {
    // cancel() rejects if the stream is already gone; nothing here may reject.
    void res.body?.cancel().catch(() => {});
  } catch {
    // A fetch implementation with no stream to cancel has nothing to release.
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
