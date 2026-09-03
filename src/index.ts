/**
 * The version of the shared SDK contract this build was verified against.
 *
 * Package versions differ per language, because each tracks its own breaking
 * changes: a rename in Python must not tell Node users something broke. What
 * makes the SDKs interchangeable is this, not the package version. Two SDKs
 * reporting the same contract version have passed the same scenarios and the
 * same vectors.
 *
 * See github.com/marginfuse/sdk-contract.
 */
export const CONTRACT_VERSION = 1;

export { MarginFuse } from "./client.js";
export { fromOpenRouter } from "./openrouter.js";
export type { OpenRouterUsage } from "./openrouter.js";
export type {
  MarginFuseOptions,
  TrackParams,
  DecideParams,
  Decision,
  IdentifyParams,
  IdentifyResult,
  DecisionAction,
  Acknowledgment,
  Usage,
  Outcome,
} from "./types.js";
