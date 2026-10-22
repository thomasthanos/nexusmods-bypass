# Diagnostics Phase 1 Implementation Plan

> **For agentic workers:** Completed with parallel D1 implementation and independent whole-change review.

**Goal:** Deliver the complete Phase 1 configuration, D1 data model, validated payload contracts, and browser extension example.

**Architecture:** A separate `diagnostics/` package preserves the existing extension and deployed relay. A future Hono Worker serves the API and Access-protected assets using one D1 database. This phase creates no server or dashboard implementation.

**Tech Stack:** TypeScript, Hono, Zod, Cloudflare D1, WebCrypto, the seven runtime packages specified in the brief, Wrangler, and Node's built-in development test runner.

**Spec:** User-provided Diagnostics, Telemetry & Error Tracking System brief, Phase 1. Source attachment: `C:/Users/Thomas/.codex/attachments/7af417f5-508b-44a8-8867-03509e5ebf47/Pasted text.txt`.

## Global Constraints

- Deliver Phase 1 only; stop until the user says `Proceed to Phase 2`.
- No incomplete functions, omitted code, or placeholder server.
- Runtime code uses standard Web APIs and only the requested edge libraries.
- Maximum request body is 65,536 UTF-8 bytes; streaming enforcement belongs to Phase 3.
- Never put credentials in source, examples, or plaintext Wrangler variables.
- The existing extension and relay remain operational.

## Review Focus

- Duplicate requests must not inflate occurrence counts, distinct installations, or release metrics.
- Hostile metadata must have bounded depth, width, strings, arrays, and serialized bytes.
- Invalid timestamps, ambiguous versions, and inconsistent counters must fail validation.
- Static assets must pass through the Worker before authentication decisions.
- Classification must not overwrite original fingerprint inputs or trust client timestamps for spike windows.

## Task 1: Contracts and project configuration

**Files:** `diagnostics/package.json`, lockfile, `wrangler.toml`, `tsconfig.json`, `src/schemas/ingest.ts`, `examples/send-report.ts`, `test/ingest.test.mjs`.

**Interfaces:** Export `errorReportSchema`, `heartbeatSchema`, `ErrorReport`, `Heartbeat`, and `MAX_BODY_BYTES`. Use random UUID request identities and a lowercase SHA-256 anonymous installation hash. Heartbeats are immutable counter deltas with separate explicit consent.

- [x] Write schema contract tests for invalid inputs and valid browser payloads; observe failure before implementation.
- [x] Pin compatible current dependencies; configure Worker-first assets, D1 automatic provisioning, and required secret names.
- [x] Implement strict finite payload schemas, canonical UTC time/date validation, SemVer validation, bounded JSON, chronological breadcrumbs, and counter relationships.
- [x] Supply a consent-gated extension example using WebCrypto and credential-free fetch.
- [x] Run contract tests and TypeScript checking.

## Task 2: Database invariants

**Files:** `diagnostics/schema.sql`, `diagnostics/test/schema.test.mjs`.

**Interfaces:** Required five tables plus heartbeat replay records and privacy-preserving rate-limit buckets. UTC integer milliseconds for server times. Browser release dimension. Report identity uniqueness, composite issue/install identity, and atomic insert triggers maintain lifetime counters.

- [x] Write executable SQLite tests for replay, invalid input, unique installations, release deltas, and cascades; observe failure before schema implementation.
- [x] Implement constraints, targeted indexes, and atomic insert triggers. Preserve original fingerprint inputs separately from classification.
- [x] Run SQLite tests and apply SQL to local D1; do not create remote resources.

## Task 3: Delivery and review

**Files:** `diagnostics/README.md` and this plan.

- [x] Document complete current and future directory layout, configuration/secret setup, payload mapping, retention semantics, and phase boundaries.
- [x] Independently review files against the Phase 1 brief and fix actionable findings.
- [x] Run all diagnostics tests, type checks, root extension tests, and lint; inspect outputs and final diff.
- [x] Deliver complete Phase 1 sources and stop before Phase 2.

## Verification record

- `diagnostics/npm run check`: TypeScript passed; 40 tests passed.
- `diagnostics/npm run db:init:local`: 34 commands applied to local D1 successfully.
- `diagnostics/npm run cf:types`: Wrangler configuration and binding generation passed.
- Browser-target bundle of all seven required runtime libraries: passed without external runtime imports.
- Root `npm test`: extension behavioral/release gates passed; Chrome and Firefox archives built.
- Root `npm run lint`: passed.
- Independent review found malformed endpoint parsing could throw; reproduced and fixed with a passing regression. UUID canonicalization and SQL NUL-string consistency also have regression coverage.
- Rate-limit route separation is encoded in the HMAC tuple rather than a separate SQL column; documentation reflects this choice.
- Complete requested code is also packaged for reading in `docs/diagnostics-phase-1.md`.
- Work is on `codex/diagnostics-phase-1`; no commits, remote changes, or deployment were made.
