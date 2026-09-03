/**
 * The package version, sent in the user-agent.
 *
 * A literal, because the published bundle has no reliable way to read its own
 * package.json: an ESM build cannot require it, a bundler may not ship it, and
 * import assertions are not portable across the runtimes this package supports.
 * A literal drifts unless something checks it, so version.test.ts asserts this
 * equals the version in package.json and CI runs it before publishing.
 */
export const VERSION = "0.3.0";
