# Contributing

## Getting set up

The conformance contract is a submodule, so clone with it:

```bash
git clone --recurse-submodules https://github.com/marginfuse/marginfuse-node
cd marginfuse-node
npm install
npm test
```

If you already cloned without it: `git submodule update --init --recursive`.

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build && npm pack
npm --prefix contract/harness install ../../marginfuse-*.tgz
npm run conformance
```

CI runs all of this on Node 18, 20, 22 and 24.

## Two rules worth knowing before you change behavior

**This SDK never throws into application code.** It sits in the request path of
somebody else's product. A transport error goes to the `onError` hook and the
call proceeds; it does not become an exception the caller has to catch. The one
exception is `guard()`, which propagates the error your own provider callback
threw, because your error handling owns that.

**Behavior is defined in the contract, not here.** The expectations live in
[marginfuse/sdk-contract](https://github.com/marginfuse/sdk-contract) as data,
and every MarginFuse SDK in every language reads the same files. If you are
changing what the SDK does rather than how it does it, the change starts with a
pull request there. Otherwise this SDK would drift away from the others, which
is the failure the contract exists to prevent.

Adding a gateway adapter means adding vectors to the contract first. An adapter
exported without them fails the suite on purpose.

## Style

Match the surrounding code. Comments explain why, not what. No em dashes.
