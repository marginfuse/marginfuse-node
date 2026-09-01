/**
 * Driven entirely by spec/conformance/gateway-vectors.json, which every SDK in
 * every language reads. Assertions written here instead would be a second copy
 * of the truth, and the Node SDK would slowly stop agreeing with the others.
 *
 * To add a case, add it to the vector file. Not here.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { fromOpenRouter, type OpenRouterUsage } from "../src/openrouter.js";

interface VectorCase {
  name: string;
  why?: string;
  input: OpenRouterUsage | null;
  omitInput?: boolean;
  expected: { usage: Record<string, number>; costUsd?: string };
}

interface VectorFile {
  version: number;
  adapters: Record<string, { provider: string; hazards: string[]; cases: VectorCase[] }>;
}

const vectorPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../contract/conformance/gateway-vectors.json",
);
const vectors = JSON.parse(readFileSync(vectorPath, "utf8")) as VectorFile;

describe("fromOpenRouter (conformance vectors)", () => {
  const suite = vectors.adapters["fromOpenRouter"];
  if (!suite) throw new Error("gateway-vectors.json has no fromOpenRouter adapter");

  it("runs every case in the vector file", () => {
    expect(suite.cases.length).toBeGreaterThan(0);
  });

  for (const c of suite.cases) {
    it(c.name, () => {
      const actual = c.omitInput === true ? fromOpenRouter(undefined) : fromOpenRouter(c.input);

      expect(actual.usage).toEqual(c.expected.usage);

      // Absent must mean absent, not present-and-zero: omitting the cost lets
      // MarginFuse price the call, where "0" would claim it was free.
      if (c.expected.costUsd === undefined) {
        expect(actual).not.toHaveProperty("costUsd");
      } else {
        expect(actual.costUsd).toBe(c.expected.costUsd);
      }
    });
  }

  it("has a vector suite for every adapter the SDK exports", async () => {
    // Adapters are a category, not a one-off: Bedrock, Vertex, Azure and
    // LiteLLM will each want one, and each will have its own version of the two
    // hazards above. An adapter added without vectors is an adapter nine other
    // languages will port by eye.
    const sdk = (await import("../src/index.js")) as Record<string, unknown>;
    const exported = Object.keys(sdk).filter(
      (name) => name.startsWith("from") && typeof sdk[name] === "function",
    );
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.filter((name) => !(name in vectors.adapters))).toEqual([]);
  });

  it("never produces a cost the API would reject", () => {
    // The decimal-string pattern from apps/api schemas.ts. Exponent notation is
    // the failure this guards, and it is silent everywhere else.
    const decimal = /^\d+(\.\d+)?$/;
    for (const c of suite.cases) {
      const actual = c.omitInput === true ? fromOpenRouter(undefined) : fromOpenRouter(c.input);
      if (actual.costUsd !== undefined) {
        expect(actual.costUsd, `${c.name}: ${actual.costUsd}`).toMatch(decimal);
      }
    }
  });
});
