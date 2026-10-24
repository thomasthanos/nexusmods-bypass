# Store analytics implementation plan

> **For agentic workers:** Use scoped parallel implementation with independent review before completion.

**Goal:** Add truthful GA4 listing activity, Chrome Web Store metrics and new-review notifications to the existing private mobile Overview.

**Architecture:** Fixed-source adapters normalize Google/Store responses. Protected routes serve short-lived private D1 snapshots; a scheduled Worker stores reviews and dispatches durable per-device push work. A separate UI module mounts alongside existing diagnostics and cleans up requests/polling on navigation.

**Tech stack:** Existing Hono/Workers, D1/SQLite, WebCrypto, buildless JavaScript, Node tests and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-store-analytics-design.md`.

## Constraints

- Main branch; preserve current UI, Access, report consent and VAPID keys.
- Only fixed property/repository/extension IDs; no new extension tracking.
- Credentials stay in Worker secrets; missing credentials are a visible setup state.
- Store users are not cumulative installs; listing activity is not extension online users.

## Review focus

- Distinct user metrics must not be summed across dates or confused with installs.
- First sync, concurrent cron runs and edited reviews must not send historical duplicates.
- Failed source fetches and stale auth must not erase valid data or another source's UI.
- Native notification links must reject foreign/malformed destinations.
- Deployment must apply additive schema changes before activating scheduled work.

## Tasks

- [x] Add fixed, bounded Store/review/latest-release adapter with offline parser tests.
- [x] Add OAuth GA4 adapter and named-range/quality/partial-response tests.
- [x] Add additive D1 schema, protected snapshot/ack routes, baseline/dedupe/lease tests and scheduled review delivery.
- [x] Add Overview cards/reviews/polling and mobile/auth/hostile-text tests.
- [x] Configure dedicated Google OAuth read access through the owner's Edge session when permitted; otherwise document the exact remaining account step.
- [ ] Review, run the required checks, apply schema, deploy, push main and verify CI.

## Verification on 24 October 2026

- Diagnostics type generation, TypeScript and 369 tests pass. Chromium and WebKit each pass all 24 mobile browser tests.
- Independent review fixes cover portable cron forwarding, partial Analytics messages, Store polling/freshness and the D1 bound-value budget.
- The additive four-table/three-index migration was applied to production through the Cloudflare API and verified with an empty foreign-key check. Existing diagnostics records were preserved.
- A dedicated Google project and Web OAuth client were created through the owner's Edge session with explicit approval. The owner completed Google's unverified-app consent, the helper proved property read access, and the optional encrypted Worker secret was installed. Live GA4 reports now render through the production Worker; no OAuth credentials reach dashboard JavaScript.
- Native Workers Assets deployment and the 15-minute cron were verified. The existing seven secrets were preserved alongside the new optional secret. The Store's complete initial baseline queued no historical review deliveries. The existing Apple push subscription was preserved; physical notification display was not tested.
- Main commit `240b61d` passed all GitHub Release gate jobs. The existing repository has no Cloudflare Actions token, so deployment was completed with the existing local Wrangler session.
