# Diagnostics Phase 3 Implementation Plan

> **For agentic workers:** Execute the authorized Phase 3 with bounded parallel implementation and independent final review.

**Goal:** Deliver the complete Hono API server, hardened extension ingest, cryptographic admin Access protection, and dashboard-facing admin endpoints.

**Architecture:** The Worker composes request security, atomic D1 persistence, the existing Phase 2 services, and protected admin routes. It serves static assets only after Access verification; no PWA implementation is added. Report retries do not change counters or repeat delivery.

**Tech Stack:** Existing pinned Hono, @hono/cloudflare-access, @hono/zod-validator, Zod, compare-versions, WebCrypto, D1, Wrangler-generated bindings, Node development tests with real SQLite.

**Spec:** User's diagnostics brief, Phase 3, at `C:/Users/Thomas/.codex/attachments/7af417f5-508b-44a8-8867-03509e5ebf47/Pasted text.txt`; command `Proceed to Phase 3`.

## Global constraints

- Phase 3 only; no dashboard HTML/JS/service worker/manifest or remote deployment.
- Complete runtime modules using Web APIs and the approved libraries only.
- All admin APIs and asset requests require verified Access issuer/audience/signature/time claims.
- Only exact ingest/heartbeat paths expose extension-origin CORS. Count raw streamed bytes up to 65,536 before JSON parsing.
- Rate limit both trusted Cloudflare IP subjects and anonymous installation IDs using HMAC hashes and atomic D1 counters.
- Sanitize before persistence/delivery; keep raw stacks only in memory for safe fingerprint normalization.
- Atomic report/heartbeat replay handling, occurrence/install/release totals, and compare-versions regression transitions.
- Use waitUntil for post-commit notification work; do not repeat deliveries for report retries.
- Preserve the existing extension, deployed legacy relay, and prior phase sources except necessary integration changes.

## Review focus

- Invalid/expired/wrong-audience Access tokens and direct static asset requests must fail closed.
- Chunked/false-length/whitespace-heavy bodies, bad content types, invalid origins, and cross-site admin mutations must be rejected.
- Concurrent first reports/retries must produce one issue, exact counters, and one regression transition; changed heartbeat identities must return conflict.
- All filters/search/pagination/date comparisons must use bounded validated parameters, with no join-multiplied counts or SQL interpolation.
- Push registration must validate provider endpoints/keys, keep credentials private, and bound subscriptions/test sends.

## Task 1: Security and configuration

**Files:** `diagnostics/src/http/types.ts`, `config.ts`, `security.ts`, security tests and signed-token fixture.

- [x] Generate binding types and use them as the environment contract.
- [x] Write failing body/CORS/IP-install-rate/CSRF/JWT tests, then implement middleware.
- [x] Verify genuine Access token signatures and safe authentication failures.

## Task 2: Persistence

**Files:** `diagnostics/src/services/ingestion.ts`, ingestion tests.

- [x] Write failing real-SQL replay, race, rollback, privacy, heartbeat and regression tests.
- [x] Implement atomic issue/report insertion and receipt-based idempotency.
- [x] Implement immutable heartbeat delta acceptance/conflicts and compare-versions regression CAS.
- [x] Verify report snapshots, current issue classification, and notification event identity.

## Task 3: Protected admin API

**Files:** `diagnostics/src/routes/admin.ts`, admin tests.

- [x] Implement bounded issue listing/filter/search, detail/report pagination, overview and release comparison.
- [x] Implement validated status/fixed-version/GitHub-link/mute updates.
- [x] Implement safe push subscription registration/list/delete/config/test endpoints.
- [x] Verify parameter binding, empty metrics, malformed payloads and subscription confidentiality.

## Task 4: Worker integration and delivery

**Files:** `diagnostics/src/index.ts`, integration tests, build/config/docs updates.

- [x] Wire exact public routes, validation, persistence and waitUntil delivery, then protected admin/assets.
- [x] Verify background delivery cannot change an accepted ingest response or duplicate on retries.
- [x] Run all diagnostics tests/type checks, local Worker build/dry-run, existing extension tests/lint.
- [x] Independently review and fix actionable issues; deliver complete Phase 3 source snapshot.
- [x] Stop before Phase 4.

## Verification record — 2026-10-22

- `diagnostics/npm run check`: generated Cloudflare binding types, strict TypeScript and all 170 tests passed.
- `wrangler deploy --dry-run --outdir .wrangler/phase3-dry-run`: bundled successfully, 958.79 KiB / 168.19 KiB gzip; no remote deployment.
- `npm run db:init:local`: all 34 schema commands succeeded on local D1.
- Root extension `npm test`, `npm run test:dom` and `npm run lint`: passed; existing Chrome/Firefox release archives built.
- Independent security/integration review: no important findings; 22 focused tests passed.
- Independent persistence/admin review reproduced two related out-of-order receipt defects: stale issue classification and a missed third-install upstream alert. New failing regression tests were added before fixes. The atomic latest-report classification refresh and latest-receipt push window fix passed independent reproductions and 69 focused tests.
- Complete Phase 3 delivery snapshot: `docs/diagnostics-phase-3.md`, 21 full files with SHA-256 integrity entries. Includes supporting modules, necessary integration changes to Phase 2 services, configuration and verification tests.
- Setup, HTTP contracts, Access policy requirements, privacy, retention and best-effort delivery limits are documented in `diagnostics/README.md`. Deployed latency and real device delivery remain unmeasured.
- No Phase 4 PWA files, commits, remote resources, live notifications or deployment were created. Existing extension and legacy relay source files were not changed.
