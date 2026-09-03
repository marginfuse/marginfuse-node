import { describe, it, expect, vi } from "vitest";
import { MarginFuse } from "../src/client.js";

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
