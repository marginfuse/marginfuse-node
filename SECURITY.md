# Security policy

## Reporting a vulnerability

Report security issues privately to **security@marginfuse.com**. Do not open a
public issue.

Include what you found, how to reproduce it, and what an attacker could do with
it. You will get an acknowledgment within two business days and an assessment
within five.

Please do not test against production MarginFuse accounts that are not your
own, and do not access, modify, or retain other people's data.

## What this SDK handles

A MarginFuse API key, and usage metadata about AI calls.

It never handles prompts, model responses, or documents. There is no field for
them in the wire types, and the conformance suite checks every outbound request
body for one on every scenario, so this is enforced rather than promised.

## Keys

- API keys are secrets. This is a server-side SDK. Never ship a key in a browser
  bundle, a mobile app, or anything else a user can read.
- Only the hash of a key is stored by MarginFuse, so a lost key is rotated,
  never recovered.
- Rotate immediately at [marginfuse.com](https://marginfuse.com) if a key is
  exposed. A leaked key can write usage events and read decisions for that
  project.

## Supported versions

The latest minor release receives security fixes.
