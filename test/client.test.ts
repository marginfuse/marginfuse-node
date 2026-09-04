import { describe, it, expect, vi } from "vitest";
import { MarginFuse, parseRetryAfter } from "../src/client.js";
import type { DecideParams, TrackParams } from "../src/types.js";

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => handler(String(input), init!));
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("decide - fail-open contract", () => {
  it("returns the server decision when healthy", async () => {
    const f = mockFetch(() =>
      ok({ id: "dec_1", action: "downgrade", model: "gpt-4.1-mini", provider: "openai" }),
    );
    const mf = new MarginFuse({ apiKey: "mf_test_x", fetch: f as unknown as typeof fetch });
    const d = await mf.decide({ customerId: "c1", provider: "openai", model: "gpt-4.1" });
    expect(d.action).toBe("downgrade");
    expect(d.model).toBe("gpt-4.1-mini");
    expect(d.degraded).toBe(false);
  });

  it("fails open to allow on timeout", async () => {
    const f = mockFetch(async (_url, init) => {
      await new Promise((r) => setTimeout(r, 200));
      if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", timeoutMs: 20, fetch: f as unknown as typeof fetch });
    const d = await mf.decide({ customerId: "c1", provider: "openai", model: "gpt-4.1" });
    expect(d.action).toBe("allow");
    expect(d.model).toBe("gpt-4.1"); // original model preserved
    expect(d.degraded).toBe(true);
  });

  it("fails open on server errors and reports via onError", async () => {
    const onError = vi.fn();
    const f = mockFetch(() => new Response("boom", { status: 500 }));
    const mf = new MarginFuse({ apiKey: "k", onError, fetch: f as unknown as typeof fetch });
    const d = await mf.decide({ customerId: "c1", provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(d.action).toBe("allow");
    expect(d.degraded).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it("fails open when fetch itself rejects", async () => {
    const f = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    const d = await mf.decide({ customerId: "c1", provider: "openai", model: "gpt-4o" });
    expect(d).toMatchObject({ action: "allow", degraded: true });
  });
});

describe("track", () => {
  it("posts the event and never throws", async () => {
    const calls: unknown[] = [];
    const f = mockFetch((url, init) => {
      calls.push([url, JSON.parse(String(init.body))]);
      return ok({ accepted: 1 });
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    mf.track({
      customerId: "c1",
      provider: "openai",
      model: "gpt-4.1",
      usage: { inputTokens: 900, outputTokens: 120 },
    });
    await mf.flush();
    expect(calls).toHaveLength(1);
    const [url, body] = calls[0] as [string, { events: Array<Record<string, unknown>> }];
    expect(url).toContain("/v1/events");
    expect(body.events[0]!.eventId).toBeTruthy(); // idempotency id auto-generated
    expect(body.events[0]!.customerId).toBe("c1");
  });

  it("retries transient failures then succeeds", async () => {
    let n = 0;
    const f = mockFetch(() => (++n < 3 ? new Response("", { status: 503 }) : ok({})));
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    mf.track({ customerId: "c1", provider: "openai", model: "m", usage: {} });
    await mf.flush();
    expect(n).toBe(3);
  });

  it("does not retry 4xx and surfaces via onError", async () => {
    const onError = vi.fn();
    let n = 0;
    const f = mockFetch(() => {
      n++;
      return new Response("bad", { status: 422 });
    });
    const mf = new MarginFuse({ apiKey: "k", onError, fetch: f as unknown as typeof fetch });
    mf.track({ customerId: "c1", provider: "openai", model: "m", usage: {} });
    await mf.flush();
    expect(n).toBe(1);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("guard", () => {
  it("blocked: acks and never calls the provider", async () => {
    const posts: string[] = [];
    const f = mockFetch((url) => {
      posts.push(url);
      if (url.includes("/decisions") && !url.includes("/ack")) {
        return ok({ id: "dec_9", action: "block", model: "gpt-4.1", provider: "openai" });
      }
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    const run = vi.fn();
    const out = await mf.guard(
      { customerId: "c1", provider: "openai", model: "gpt-4.1" },
      run as never,
    );
    await mf.flush();
    expect(out.kind).toBe("blocked");
    expect(run).not.toHaveBeenCalled();
    expect(posts.some((u) => u.includes("/decisions/dec_9/ack"))).toBe(true);
  });

  it("enforces a block even when the response carries no ack id", async () => {
    // Enforcement must key off the action alone. Losing the id costs an
    // acknowledgment; it must never downgrade a block into a provider call.
    const f = mockFetch(() => ok({ action: "block", model: "gpt-4.1", provider: "openai" }));
    const run = vi.fn();
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    const out = await mf.guard({ customerId: "c1", provider: "openai", model: "gpt-4.1" }, run);

    expect(out.kind).toBe("blocked");
    expect(run).not.toHaveBeenCalled();
    await mf.flush();
    // No id to ack with, so decisions and events stay untouched.
    const paths = f.mock.calls.map((c) => String(c[0]));
    expect(paths.filter((u) => u.includes("/ack"))).toHaveLength(0);
    expect(paths.filter((u) => u.includes("/v1/events"))).toHaveLength(0);
  });

  it("topup_required: never calls the provider, and passes the context through", async () => {
    const f = mockFetch((url) =>
      url.includes("/v1/decisions/")
        ? ok({ ok: true })
        : ok({
            id: "dec_t",
            action: "topup_required",
            model: "gpt-4.1",
            provider: "openai",
            topupContext: "buy-credits",
          }),
    );
    const run = vi.fn();
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    const out = await mf.guard({ customerId: "c1", provider: "openai", model: "gpt-4.1" }, run);

    expect(out.kind).toBe("topup_required");
    expect(out.decision.topupContext).toBe("buy-credits");
    expect(run).not.toHaveBeenCalled();
    await mf.flush();
    const ackCall = f.mock.calls.find((c) => String(c[0]).includes("/ack"));
    expect(ackCall).toBeDefined();
    expect(JSON.parse(String((ackCall![1] as RequestInit).body))).toEqual({
      acknowledgment: "presented_topup",
    });
    // Nothing ran, so nothing is reported as usage.
    expect(f.mock.calls.filter((c) => String(c[0]).includes("/v1/events"))).toHaveLength(0);
  });

  it("enforces topup_required with no ack id too", async () => {
    const f = mockFetch(() => ok({ action: "topup_required", model: "gpt-4.1", provider: "openai" }));
    const run = vi.fn();
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    const out = await mf.guard({ customerId: "c1", provider: "openai", model: "gpt-4.1" }, run);

    expect(out.kind).toBe("topup_required");
    expect(run).not.toHaveBeenCalled();
  });

  it("downgrade: runs with the replacement model, reports usage with decision link", async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = mockFetch((url, init) => {
      bodies.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
      if (url.endsWith("/v1/decisions")) {
        return ok({ id: "dec_2", action: "downgrade", model: "gpt-4.1-mini", provider: "openai" });
      }
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    const out = await mf.guard(
      { customerId: "c1", feature: "ai_chat", provider: "openai", model: "gpt-4.1" },
      async ({ model }) => {
        expect(model).toBe("gpt-4.1-mini");
        return { result: "resp", usage: { inputTokens: 500, outputTokens: 80 } };
      },
    );
    await mf.flush();
    expect(out.kind).toBe("completed");
    const eventPost = bodies.find((b) => b.url.endsWith("/v1/events"));
    const ev = (eventPost!.body as { events: Array<Record<string, unknown>> }).events[0]!;
    expect(ev.model).toBe("gpt-4.1-mini");
    expect(ev.requestedModel).toBe("gpt-4.1");
    expect(ev.decisionId).toBe("dec_2");
    const ack = bodies.find((b) => b.url.includes("/ack"));
    expect((ack!.body as { acknowledgment: string }).acknowledgment).toBe("used_downgrade_model");
  });

  it("degraded decide: proceeds with original model (fail-open end to end)", async () => {
    const f = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith("/v1/decisions")) throw new Error("down");
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    const out = await mf.guard(
      { customerId: "c1", provider: "openai", model: "gpt-4.1" },
      async ({ model }) => ({ result: model, usage: {} }),
    );
    expect(out.kind).toBe("completed");
    expect(out.kind === "completed" && out.result).toBe("gpt-4.1");
    expect(out.decision.degraded).toBe(true);
  });

  it("provider error: still reports an event, then rethrows to the app", async () => {
    const bodies: string[] = [];
    const f = mockFetch((url) => {
      bodies.push(url);
      if (url.endsWith("/v1/decisions")) return ok({ id: "dec_3", action: "allow", model: "m", provider: "openai" });
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    await expect(
      mf.guard({ customerId: "c1", provider: "openai", model: "m" }, async () => {
        throw new Error("provider exploded");
      }),
    ).rejects.toThrow("provider exploded");
    await mf.flush();
    expect(bodies.some((u) => u.endsWith("/v1/events"))).toBe(true);
  });
});

describe("identify - the plan a customer is on", () => {
  it("sends the plan and returns what is now in force", async () => {
    const calls: unknown[] = [];
    const f = mockFetch((url, init) => {
      calls.push([url, JSON.parse(String(init.body))]);
      return ok({ customerId: "cus_local_1", plan: "pro", periodStart: "2026-09-01T00:00:00.000Z" });
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    const res = await mf.identify({
      customerId: "acct_9001",
      plan: "pro",
      name: "Acme",
      metadata: { tier: "legacy" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.plan).toBe("pro");
      expect(res.result.customerId).toBe("cus_local_1");
    }
    const [url, body] = calls[0] as [string, Record<string, unknown>];
    expect(url).toContain("/v1/identify");
    expect(body).toEqual({ customerId: "acct_9001", plan: "pro", name: "Acme", metadata: { tier: "legacy" } });
  });

  it("omits what the caller did not set, so absent never means 'clear it'", async () => {
    const calls: unknown[] = [];
    const f = mockFetch((_url, init) => {
      calls.push(JSON.parse(String(init.body)));
      return ok({ customerId: "c", plan: null });
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    await mf.identify({ customerId: "acct_9001" });
    expect(calls[0]).toEqual({ customerId: "acct_9001" });
  });

  it("sends a backdated cycle start as an ISO instant", async () => {
    const calls: unknown[] = [];
    const f = mockFetch((_url, init) => {
      calls.push(JSON.parse(String(init.body)));
      return ok({ customerId: "c", plan: "pro" });
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    await mf.identify({ customerId: "a", plan: "pro", periodStart: new Date(Date.UTC(2026, 5, 5, 9, 30)) });
    expect((calls[0] as Record<string, unknown>).periodStart).toBe("2026-06-05T09:30:00.000Z");
  });

  it("reports a rejection instead of throwing, because a wrong plan is a wrong margin", async () => {
    const onError = vi.fn();
    const f = mockFetch(() => new Response(JSON.stringify({ error: "plan_not_found" }), { status: 404 }));
    const mf = new MarginFuse({ apiKey: "k", onError, fetch: f as unknown as typeof fetch });

    const res = await mf.identify({ customerId: "a", plan: "nope" });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("404");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("survives an unreachable server the same way", async () => {
    const onError = vi.fn();
    const f = mockFetch(() => {
      throw new Error("network down");
    });
    const mf = new MarginFuse({ apiKey: "k", onError, fetch: f as unknown as typeof fetch });
    const res = await mf.identify({ customerId: "a", plan: "pro" });
    expect(res.ok).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("plan hint on usage and decisions", () => {
  it("track carries the plan through", async () => {
    const calls: unknown[] = [];
    const f = mockFetch((_url, init) => {
      calls.push(JSON.parse(String(init.body)));
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    mf.track({ customerId: "c1", plan: "pro", provider: "openai", model: "gpt-4.1", usage: {} });
    await mf.flush();
    const body = calls[0] as { events: Array<Record<string, unknown>> };
    expect(body.events[0]!.plan).toBe("pro");
  });

  it("guard forwards the plan to both the decision and the usage it reports", async () => {
    const bodies: Array<[string, Record<string, unknown>]> = [];
    const f = mockFetch((url, init) => {
      bodies.push([url, JSON.parse(String(init.body))]);
      if (url.includes("/v1/decisions") && !url.includes("/ack")) {
        return ok({ id: "dec_1", action: "allow", model: "gpt-4.1", provider: "openai", degraded: false });
      }
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    await mf.guard(
      { customerId: "c1", plan: "pro", provider: "openai", model: "gpt-4.1" },
      async () => ({ result: 1, usage: { inputTokens: 10 } }),
    );
    await mf.flush();

    const decideBody = bodies.find(([u]) => u.endsWith("/v1/decisions"))![1];
    expect(decideBody.plan).toBe("pro");
    const eventsBody = bodies.find(([u]) => u.endsWith("/v1/events"))![1] as {
      events: Array<Record<string, unknown>>;
    };
    expect(eventsBody.events[0]!.plan).toBe("pro");
  });
});

describe("the wire format cannot express prompt content", () => {
  // README invariant 5 / §5.6 / §33. The type says there is no field for
  // content, but the type is not what leaves the process: TypeScript's
  // excess-property check fires on a fresh object literal and never on a
  // variable, and real applications assemble their parameters in variables.
  // These assert on the bytes.
  const SECRET = "PATIENT SSN 123-45-6789";

  function bodiesOf(f: ReturnType<typeof mockFetch>): string[] {
    return f.mock.calls.map((c) => String((c[1] as RequestInit).body));
  }

  it("track drops everything it was not asked for, however it was handed over", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const f = mockFetch((_url, init) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    const params = {
      customerId: "c1",
      provider: "openai",
      model: "gpt-4.1",
      usage: { inputTokens: 900, outputTokens: 120 },
      prompt: SECRET,
      messages: [{ role: "user", content: SECRET }],
      response: SECRET,
    } as unknown as TrackParams;
    mf.track(params);
    await mf.flush();

    expect(bodiesOf(f).join("")).not.toContain(SECRET);
    const event = (calls[0] as { events: Array<Record<string, unknown>> }).events[0]!;
    expect(Object.keys(event).sort()).toEqual(
      ["customerId", "eventId", "model", "occurredAt", "outcome", "provider", "usage"].sort(),
    );
  });

  it("usage carries the six metered quantities and nothing else", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const f = mockFetch((_url, init) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    // `Usage` is an interface, so a variable with extra keys satisfies it.
    const usage = { inputTokens: 10, prompt: SECRET } as unknown as TrackParams["usage"];
    mf.track({ customerId: "c1", provider: "openai", model: "m", usage });
    await mf.flush();

    const event = (calls[0] as { events: Array<Record<string, unknown>> }).events[0]!;
    expect(event.usage).toEqual({ inputTokens: 10 });
    expect(bodiesOf(f).join("")).not.toContain(SECRET);
  });

  it("decide sends the decision fields only", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const f = mockFetch((_url, init) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return ok({ id: "d1", action: "allow", model: "gpt-4.1", provider: "openai", degraded: false });
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    const params = {
      customerId: "c1",
      provider: "openai",
      model: "gpt-4.1",
      expectedUsage: { inputTokens: 100, prompt: SECRET },
      messages: [{ role: "user", content: SECRET }],
    } as unknown as DecideParams;
    await mf.decide(params);

    expect(calls[0]).toEqual({
      customerId: "c1",
      provider: "openai",
      model: "gpt-4.1",
      expectedUsage: { inputTokens: 100 },
    });
    expect(bodiesOf(f).join("")).not.toContain(SECRET);
  });

  it("an eventId that is present but undefined still gets one generated", async () => {
    // `eventId: maybeId` is ordinary TypeScript. A spread put that undefined
    // over the generated default, the API answered 422, and the event was
    // dropped without a sound (the default onError does nothing).
    const calls: Array<Record<string, unknown>> = [];
    const f = mockFetch((_url, init) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    const maybeId: string | undefined = undefined;
    // The cast is this repo's exactOptionalPropertyTypes, not the customer's:
    // that flag is off by default, so `eventId: maybeId` compiles as written in
    // the applications this SDK ships to. The bytes are the same either way.
    mf.track({
      eventId: maybeId,
      customerId: "c1",
      provider: "openai",
      model: "gpt-4.1",
      usage: { inputTokens: 1 },
    } as unknown as TrackParams);
    await mf.flush();

    const event = (calls[0] as { events: Array<Record<string, unknown>> }).events[0]!;
    expect(event.eventId).toMatch(/^evt_/);
  });
});

describe("guard reports what actually happened", () => {
  function downgradeTo(model: string, provider: string) {
    const bodies: Array<[string, Record<string, unknown>]> = [];
    const f = mockFetch((url, init) => {
      bodies.push([url, JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>]);
      if (url.endsWith("/v1/decisions")) {
        return ok({ id: "dec_x", action: "downgrade", model, provider, degraded: false });
      }
      return ok({});
    });
    return { f, bodies };
  }

  it("a cross-vendor downgrade is billed to the provider that ran, not the one asked for", async () => {
    // The server may downgrade across vendors, which is why the callback is
    // handed decision.provider. Reporting params.provider priced the call from
    // the wrong catalogue: run on Anthropic, billed as OpenAI.
    const { f, bodies } = downgradeTo("claude-haiku-4-5", "anthropic");
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    const out = await mf.guard(
      { customerId: "c1", provider: "openai", model: "gpt-4.1" },
      async ({ model, provider }) => {
        expect(model).toBe("claude-haiku-4-5");
        expect(provider).toBe("anthropic");
        return { result: "resp", usage: { inputTokens: 50 } };
      },
    );
    await mf.flush();

    expect(out.kind).toBe("completed");
    const ev = (
      bodies.find(([u]) => u.endsWith("/v1/events"))![1] as { events: Array<Record<string, unknown>> }
    ).events[0]!;
    expect(ev.provider).toBe("anthropic");
    expect(ev.model).toBe("claude-haiku-4-5");
    expect(ev.requestedModel).toBe("gpt-4.1");
  });

  it("a downgrade whose provider call then fails is still acknowledged as a downgrade", async () => {
    const { f, bodies } = downgradeTo("gpt-4.1-mini", "openai");
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    await expect(
      mf.guard({ customerId: "c1", provider: "openai", model: "gpt-4.1" }, async () => {
        throw new Error("provider exploded");
      }),
    ).rejects.toThrow("provider exploded");
    await mf.flush();

    const ack = bodies.find(([u]) => u.includes("/ack"))![1] as { acknowledgment: string };
    expect(ack.acknowledgment).toBe("used_downgrade_model");
    const ev = (
      bodies.find(([u]) => u.endsWith("/v1/events"))![1] as { events: Array<Record<string, unknown>> }
    ).events[0]!;
    expect(ev.model).toBe("gpt-4.1-mini");
    expect(ev.outcome).toBe("provider_error");
  });

  it("the usage event goes out before the ack that refers to it", async () => {
    const order: string[] = [];
    const f = mockFetch((url) => {
      order.push(new URL(url).pathname);
      if (url.endsWith("/v1/decisions")) {
        return ok({ id: "dec_o", action: "allow", model: "m", provider: "openai", degraded: false });
      }
      return ok({});
    });
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    await mf.guard({ customerId: "c1", provider: "openai", model: "m" }, async () => ({
      result: 1,
      usage: { inputTokens: 3 },
    }));
    await mf.flush();

    // Batching must not let the ack overtake the event: an ack that arrives
    // first describes a call MarginFuse has not been told about yet.
    expect(order).toEqual(["/v1/decisions", "/v1/events", "/v1/decisions/dec_o/ack"]);
  });
});

describe("the SDK never becomes the application's failure", () => {
  it("an onError that throws is swallowed rather than crashing the process", async () => {
    // onError is called from inside background tasks that nothing awaits unless
    // the application calls flush(). An unhandled rejection there terminates a
    // Node process under the default settings (§5.5).
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      const f = mockFetch(() => new Response("bad", { status: 422 }));
      const mf = new MarginFuse({
        apiKey: "k",
        batchIntervalMs: 0,
        onError: () => {
          throw new Error("the application's own logger is broken");
        },
        fetch: f as unknown as typeof fetch,
      });

      // Deliberately no flush: this is the path where nothing is awaited.
      mf.track({ customerId: "c1", provider: "openai", model: "m", usage: {} });
      await new Promise((r) => setTimeout(r, 100));
      // And the awaited path resolves normally too.
      await expect(mf.flush()).resolves.toBeUndefined();
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toEqual([]);
  });

  it("a decide whose onError throws still returns a fail-open decision", async () => {
    const f = mockFetch(() => new Response("boom", { status: 500 }));
    const mf = new MarginFuse({
      apiKey: "k",
      onError: () => {
        throw new Error("the application's own logger is broken");
      },
      fetch: f as unknown as typeof fetch,
    });
    const d = await mf.decide({ customerId: "c1", provider: "openai", model: "gpt-4.1" });
    expect(d).toMatchObject({ action: "allow", degraded: true, model: "gpt-4.1" });
  });

  it("reports a thrown non-Error as an Error, because onError is typed to receive one", async () => {
    const errors: Error[] = [];
    const f = vi.fn(async () => {
      throw "ECONNRESET"; // eslint-disable-line no-throw-literal
    });
    const mf = new MarginFuse({
      apiKey: "k",
      onError: (e) => errors.push(e),
      fetch: f as unknown as typeof fetch,
    });
    await mf.decide({ customerId: "c1", provider: "openai", model: "m" });
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]!.message).toBe("ECONNRESET");
  });
});

describe("buffering", () => {
  function collector(): {
    f: ReturnType<typeof mockFetch>;
    batches: Array<Array<Record<string, unknown>>>;
  } {
    const batches: Array<Array<Record<string, unknown>>> = [];
    const f = mockFetch((url, init) => {
      if (url.endsWith("/v1/events")) {
        const body = JSON.parse(String(init.body)) as { events: Array<Record<string, unknown>> };
        batches.push(body.events);
      }
      return ok({});
    });
    return { f, batches };
  }

  const event = (eventId: string): TrackParams => ({
    eventId,
    customerId: "c1",
    provider: "openai",
    model: "gpt-4.1",
    usage: { inputTokens: 1 },
  });

  it("coalesces events into one request instead of one request per AI call", async () => {
    const { f, batches } = collector();
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    mf.track(event("a"));
    mf.track(event("b"));
    mf.track(event("c"));
    await mf.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.eventId)).toEqual(["a", "b", "c"]);
  });

  it("never puts more than the server's 500 in one body", async () => {
    const { f, batches } = collector();
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    for (let i = 0; i < 501; i++) mf.track(event(`e${i}`));
    await mf.flush();

    expect(batches.map((b) => b.length)).toEqual([500, 1]);
  });

  it("sends on its own timer, so an application that never flushes still reports", async () => {
    const { f, batches } = collector();
    const mf = new MarginFuse({ apiKey: "k", batchIntervalMs: 20, fetch: f as unknown as typeof fetch });
    mf.track(event("a"));
    expect(batches, "the caller is never blocked on the send").toHaveLength(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(batches).toHaveLength(1);
  });

  it("drops the newest event when the queue is full, and says so once", async () => {
    const errors: Error[] = [];
    const { f, batches } = collector();
    const mf = new MarginFuse({
      apiKey: "k",
      maxQueuedEvents: 2,
      onError: (e) => errors.push(e),
      fetch: f as unknown as typeof fetch,
    });

    mf.track(event("a"));
    mf.track(event("b"));
    mf.track(event("c")); // over the bound
    mf.track(event("d")); // over it too, but not a second complaint
    await mf.flush();

    expect(batches[0]!.map((e) => e.eventId)).toEqual(["a", "b"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("maxQueuedEvents");

    // The bound is an episode, not a permanent state: once the queue drains,
    // tracking works again and a later overflow is reported again.
    mf.track(event("e"));
    await mf.flush();
    expect(batches[1]!.map((ev) => ev.eventId)).toEqual(["e"]);
  });

  it("caps how many requests are in flight at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const f = mockFetch(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return ok({});
    });
    const mf = new MarginFuse({
      apiKey: "k",
      batchIntervalMs: 0,
      maxConcurrentRequests: 1,
      fetch: f as unknown as typeof fetch,
    });

    for (const id of ["a", "b", "c"]) {
      mf.track(event(id));
      await new Promise((r) => setTimeout(r, 5)); // let each batch close
    }
    await mf.flush();

    expect(f.mock.calls).toHaveLength(3);
    expect(peak).toBe(1);
  });

  it("trackAndWait still drains what it queued", async () => {
    const { f, batches } = collector();
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });
    await expect(mf.trackAndWait(event("a"))).resolves.toBeUndefined();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.eventId)).toEqual(["a"]);
  });
});

describe("retry backoff", () => {
  it("waits as long as the server asked when it sends Retry-After", async () => {
    let n = 0;
    const f = mockFetch(() =>
      ++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "1" } }) : ok({}),
    );
    const mf = new MarginFuse({ apiKey: "k", fetch: f as unknown as typeof fetch });

    const started = Date.now();
    mf.track({ customerId: "c1", provider: "openai", model: "m", usage: {} });
    await mf.flush();

    expect(n).toBe(2);
    // The schedule's own first wait tops out at 500 ms, so a wait past a second
    // can only have come from the header.
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  it("reads both forms of Retry-After, and refuses to be told anything absurd", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter(" 2 ")).toBe(2000);

    const soon = parseRetryAfter(new Date(Date.now() + 5_000).toUTCString());
    expect(soon).toBeGreaterThan(3_000);
    expect(soon).toBeLessThanOrEqual(6_000);

    // A stale date is a zero wait, never a negative one.
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
    // An hour is longer than we are willing to hold events in memory.
    expect(parseRetryAfter("3600")).toBe(60_000);

    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
