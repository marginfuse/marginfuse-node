import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { VERSION } from "../src/version.js";

/**
 * The user-agent is how a support conversation starts: someone reports odd
 * behaviour and the first question is which version sent the request.
 *
 * 0.2.1 shipped answering that question with "0.1.0". The string was written
 * once and never moved again, because nothing compared it to anything. This
 * is that comparison.
 */
describe("the reported version", () => {
  it("is the version that was published", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(VERSION).toBe(pkg.version);
  });
});
