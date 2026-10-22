# Diagnostics Phase 2 Implementation Plan

> **For agentic workers:** Execute the authorized Phase 2 with parallel bounded tasks and independent final review.

**Goal:** Deliver complete sanitization, fingerprinting, classification, and Discord/Web Push services without adding API routes or PWA assets.

**Architecture:** Pure privacy and classification functions feed D1-backed notification decisions. Atomic leases prevent duplicate push events and enforce per-issue cooldowns; network transports encrypt with the requested WebCrypto library and return bounded, non-sensitive outcomes. The future Phase 3 router invokes the services after persistence using its execution context.

**Tech Stack:** Existing pinned TypeScript/Zod packages, error-stack-parser-es, compare-versions, @block65/webcrypto-web-push, standard Web APIs, D1, Node development tests with real SQLite.

**Spec:** User-provided four-phase diagnostics brief at `C:/Users/Thomas/.codex/attachments/7af417f5-508b-44a8-8867-03509e5ebf47/Pasted text.txt`, Phase 2; user command `Proceed to Phase 2`.

## Global constraints

- Phase 2 only. No `src/index.ts`, API routes, deployment, or PWA.
- No incomplete functions or placeholders; no Node runtime imports.
- Preserve existing Phase 1 payload and SQL contracts and the legacy extension/relay.
- Remove credentials/PII before storage, fingerprinting, or delivery.
- Use the exact Greek suggested actions in the brief for the six core rules.
- Server receipt time controls 15-minute windows, with at least three distinct installations for canaries and at least ten reports across three installations for spikes.
- Push cooldown defaults to thirty minutes; only a committed regression transition bypasses it. Ignored/muted issues never send push.
- No live webhook/push calls or external changes during verification.

## Review focus

- Quoted credentials, nested metadata, URLs, and OS paths must not leak through exported text or embeds.
- Extension UUIDs and source positions must not split equivalent issue fingerprints.
- Recovered breadcrumb failures must not misclassify the terminal error.
- Concurrent events, failed sends, partial delivery, expired leases, and provider expiry must preserve cooldown/claim ownership.
- Push endpoint SSRF, redirects, malformed key material, cryptographic payload limits, and provider errors need explicit handling.

## Task 1: Privacy and fingerprinting

**Files:** `diagnostics/src/utils/sanitize.ts`, `fingerprint.ts`, their tests.

- [x] Write failing privacy/fingerprint tests.
- [x] Implement bounded non-mutating sanitizer and schema-valid sanitized reports.
- [x] Parse and normalize browser stacks; SHA-256 the unambiguous original error-identity tuple.
- [x] Verify redaction, determinism, browser frame variants, and type checks.

## Task 2: Rule engine

**Files:** `diagnostics/src/services/ruleEngine.ts`, its tests.

- [x] Write failing pure classification and real-SQL window tests.
- [x] Implement six required patterns plus API schema mismatch and conservative unknown handling.
- [x] Read distinct installations for the same issue using bounded server-time queries; return classification without mutating stored reports.
- [x] Verify threshold boundaries, future/old timestamps, repeated installs, and recovered fallback paths.

## Task 3: Notification services

**Files:** `diagnostics/src/services/delivery.ts`, `notifications.ts`, their tests, `test/helpers/d1.mjs`.

- [x] Write failing network-contract, crypto, cooldown, concurrency, and delivery-outcome tests.
- [x] Implement WebCrypto Web Push, constrained provider endpoints, VAPID validation, and rich sanitized Discord embeds.
- [x] Implement persisted-report checks, trigger priority, atomic claim/lease reservation, cooldown, successful completion, failure release, subscription cleanup, and test notification service.
- [x] Verify real SQLite queries and real encrypted payloads with mocked transport boundaries.

## Task 4: Review and delivery

- [x] Run the complete diagnostics checks and edge bundle verification, plus existing extension tests/lint.
- [x] Independently review and fix actionable issues.
- [x] Document service contracts and delivery semantics; deliver complete Phase 2 code snapshot.
- [x] Stop before Phase 3.

## Completion record

- Full diagnostics verification: `npm run check`, 115 tests passed; TypeScript passed.
- Existing extension verification: root `npm test` passed; Chrome/Firefox release archives built.
- Root `npm run lint` passed.
- All five Phase 2 runtime modules bundled in memory for browser/Web API execution without external runtime imports.
- Genuine RFC 8291 ciphertext was decrypted in tests and VAPID JWT signatures verified; all HTTP boundaries mocked.
- Independent review produced five actionable findings. Regression tests reproduced and fixed spaced-username redaction, credential-bearing identifier/version fields, common session aliases, contextual API mismatch overriding terminal network failures, and cleanup failure releasing claims while other pushes remained in flight.
- Discord and every started push worker now settle independently before completion, including failure paths.
- Delivery code is complete in `docs/diagnostics-phase-2.md`; detailed module contracts and explicit best-effort delivery limits are in `diagnostics/README.md`.
- Supporting transport module `delivery.ts` separates crypto/network validation from D1 orchestration; it is delivered in full alongside the four requested files.
- No schema change, dependency change, server/PWA implementation, commit, deployment, remote resource, or live notification delivery was performed in Phase 2.
- Stopped at the Phase 2 boundary. Phase 3 requires the user's next command.