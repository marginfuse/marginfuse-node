# marginfuse

[![npm](https://img.shields.io/npm/v/marginfuse)](https://www.npmjs.com/package/marginfuse)
[![ci](https://github.com/marginfuse/marginfuse-node/actions/workflows/ci.yml/badge.svg)](https://github.com/marginfuse/marginfuse-node/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Server-side SDK for [MarginFuse](https://marginfuse.com): profitability
guardrails for AI SaaS. Connect revenue to per-request AI cost, see gross margin
per customer, and stop loss-making requests before they run.

- **Metadata only, by construction.** The event shape has no field for prompts
  or responses, so they cannot be sent. Not a policy, an absence.
- **Never breaks your app.** It does not throw into your code, and it does not
  block your request on MarginFuse being up. If MarginFuse is unreachable, your
  requests proceed unchanged.
- **Zero dependencies.** Node 18+, Next.js route handlers, serverless functions.

> **Server side only.** This SDK carries a secret API key. Never ship it in a
> browser bundle, a mobile app, or anything else a user can read.

## Install

```bash
npm install marginfuse
```

## Track an AI call

Monitoring. One call after each AI request, metadata only.

```ts
import { MarginFuse } from "marginfuse";

const mf = new MarginFuse({ apiKey: process.env.MARGINFUSE_KEY! });

mf.track({
  customerId: "cus_8x2m91",   // your Stripe customer id, or your own id
  feature: "ai_chat",
  provider: "openai",
  model: "gpt-4.1",
  usage: { inputTokens: 1204, outputTokens: 388 },
  // or costUsd: "0.0084" when your provider reports the real charge
});
```

`track()` is fire and forget with retries. In a script or a background job, call
`await mf.flush()` before the process exits, or the last events are lost.

## Guard a call

Protection. Ask before the call runs, and act on the answer.

```ts
const out = await mf.guard(
  { customerId: "cus_8x2m91", feature: "ai_chat", provider: "openai", model: "gpt-4.1" },
  async ({ model }) => {
    const r = await openai.chat.completions.create({ model, messages });
    return {
      result: r,
      usage: { inputTokens: r.usage.prompt_tokens, outputTokens: r.usage.completion_tokens },
    };
  },
);

if (out.kind === "completed") use(out.result);
// out.kind === "blocked" | "topup_required" -> your own UX decides what to show
```

One wrapper does the whole loop: ask, run with the resolved model, report the
real cost, acknowledge what your application did. A `downgrade` verdict changes
the `model` your callback receives, so the cheaper model is actually the one
that runs.

Policies run in dry-run first. You see what protection would have done against
your real traffic before anything is allowed to act.

## Tell MarginFuse what a customer pays

Margin needs a revenue side: Stripe for web billing, RevenueCat for App Store
and Google Play proceeds, or declared plan prices. RevenueCat joins by App User
ID; use that same ID in your events. Without a billing connection, declare your
plans in MarginFuse and say which plan each customer is on. Declared revenue
is unverified and does not confirm payment:

```ts
const res = await mf.identify({
  customerId: "user_8x2m91",
  plan: "pro",                    // the key of a plan you declared in Settings
  name: "Acme Studio",
  metadata: { tier: "legacy" },   // labels segment policies can match on
});

if (!res.ok) console.warn("MarginFuse identify:", res.error);
```

Safe to call on every sign-in: sending the plan the customer is already on
changes nothing. Sending a different one ends the current cycle and prorates
what accrued. `periodStart` backdates the cycle for a customer who has been
paying since an earlier date; `clearPlan: true` takes them off plans.

This is the one call that does not fail open. `track()` retries later and
`decide()` allows, because both have a safe default; "I could not record what
this customer pays" has none, and a wrong plan is a wrong margin. So it reports
the failure to you instead of swallowing it. It still never throws.

`track()`, `guard()` and `decide()` also accept a `plan`, so it can ride along
with usage rather than needing its own call. There it is a hint: a key that
does not resolve is ignored rather than failing your event.

## OpenRouter and other gateways

Gateways report the real cost of every call. Forward it and your figures are
exact instead of estimated.

```ts
import { MarginFuse, fromOpenRouter } from "marginfuse";

const r = await openai.chat.completions.create({ model: "anthropic/claude-sonnet-4.5", messages });

mf.track({
  customerId: "cus_8x2m91",
  feature: "ai_chat",
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.5",
  ...fromOpenRouter(r.usage),
});
```

Use the helper rather than mapping the fields yourself. OpenRouter's
`prompt_tokens` already includes cached reads and cache writes, which MarginFuse
prices separately, so passing it through directly charges every cached token
twice at the full input rate. The helper also formats the cost as a decimal
string, because `String(cost)` produces `1.2e-7` for small costs and the API
rejects that.

If a gateway event arrives without a cost, MarginFuse prices it from the
upstream vendor's list price for the model behind the id and labels the figure
**EST**, because the gateway's own margin is not in that number.

## Configuration

```ts
new MarginFuse({
  apiKey: process.env.MARGINFUSE_KEY!,
  baseUrl: "https://api.marginfuse.com",  // point at your own deployment in dev
  timeoutMs: 1500,                        // decide() budget before failing open
  onError: (err, context) => log.warn({ err, context }),  // SDK transport errors are reported here
});
```

## What it sends

Everything, and nothing else:

```
eventId  customerId  feature  provider  model  requestedModel  plan
usage { inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens, images, audioSeconds }
costUsd  occurredAt  outcome  decisionId  retryOfEventId  correctsEventId
```

There is no field for message content anywhere in the wire types. The
[conformance suite](https://github.com/marginfuse/sdk-contract) checks this
against the bytes that actually leave the process, on every scenario.

## Conformance

This SDK is verified against
[marginfuse/sdk-contract](https://github.com/marginfuse/sdk-contract), the same
contract every MarginFuse SDK in every language is held to. It is a submodule
here, so the pinned commit records exactly which contract a release passed.

```bash
git clone --recurse-submodules https://github.com/marginfuse/marginfuse-node
cd marginfuse-node
npm install
npm test          # unit tests, plus the shared gateway vectors
npm run build && npm pack
npm --prefix contract/harness install ../../marginfuse-*.tgz
npm run conformance   # 24 scenarios against the packed artifact
```

## Links

- [MarginFuse](https://marginfuse.com), product and pricing
- [Live demo](https://marginfuse.com/demo), a read-only workspace, no signup
- [API reference](https://api.marginfuse.com/openapi.json)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

MIT, Pemira Labs.
