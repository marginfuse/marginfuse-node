/**
 * The exported contract version has to be the one this build was actually
 * verified against, or it is a claim rather than a fact.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "../src/index.js";

describe("CONTRACT_VERSION", () => {
  it("matches the pinned contract", () => {
    const pinned = JSON.parse(
      readFileSync(
        resolve(__dirname, "../contract/conformance/behavior-scenarios.json"),
        "utf8",
      ),
    ) as { version: number };
    expect(CONTRACT_VERSION).toBe(pinned.version);
  });
});
