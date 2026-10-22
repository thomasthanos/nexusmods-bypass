# Diagnostics Phase 4 Implementation Plan

> **For agentic workers:** Execute the explicitly authorized Phase 4 in this checkout with bounded parallel implementation and independent review. The original written brief and the user's `Proceed to Phase 4` authorize the implementation; no additional design approval is needed.

**Goal:** Deliver the complete private mobile-first PWA dashboard, issue workflow, release comparisons and iOS Web Push experience.

**Architecture:** Buildless static HTML, CSS and ES modules in `diagnostics/public/` use the existing same-origin protected Hono admin API. A push-only service worker displays notifications and validates deep links without caching private pages or responses. Existing Access verification continues to guard every asset.

**Tech Stack:** Vanilla JavaScript, Tailwind browser CDN, platform DOM/Fetch/Push/Service Worker/Clipboard/Badging APIs, existing Hono/D1 backend. Node's test runner and Playwright are development-only.

**Spec:** `C:/Users/Thomas/.codex/attachments/7af417f5-508b-44a8-8867-03509e5ebf47/Pasted text.txt`, Phase 4 and preceding core feature requirements.

## Global constraints

- Four complete requested files: `index.html`, `app.js`, `sw.js`, `manifest.json`, with focused supporting CSS/JS/icons where useful.
- No frontend build step, Node runtime, invented live diagnostics, runtime secrets, auth bypass, remote deployment, or unrelated extension/relay changes.
- Private data remains in memory; no service-worker response cache, localStorage or IndexedDB diagnostics persistence.
- iOS installation guidance, explicit user-gesture notification permission, feature detection, safe areas and reduced motion; do not claim untested device compatibility.
- API/clipboard errors are visible and recoverable; HTML/JSON/redirect Access challenges must never be treated as successful API responses.

## Design direction

Continue the extension's warm amber identity with a quieter field-console layout: ink `#10111a`, panel `#191c29`, raised `#222638`, text `#edf0f7`, secondary `#a9b3c9`, amber `#efb768`; semantic mint/red distinguish health and regressions. System SF/Segoe UI typography, tabular figures, code font only for diagnostic evidence. One release-health strip, ranked incident rows, and a chronological waterfall carry the hierarchy. Mobile bottom navigation and a full-height issue sheet expand to a constrained desktop workspace. No decorative hero or demo counters.

## Review focus

- Stale requests, filter changes, rapid issue navigation, dialog closure and expired Access sessions must not reveal old data or overwrite newer selections.
- Malicious error messages, metadata, GitHub links and push payload URLs render as text or validated links, never executable markup or cross-origin navigation.
- Empty/zero metrics and retained-report deletion remain understandable; no fabricated success rates or unsupported spike claims.
- iOS permission gestures, existing subscriptions, failed server registration and lost Access sessions keep local/server push state recoverable.
- Service worker always displays a visible fallback notification, bounds text/badges, and focuses or opens only the validated same-origin issue route.

## Shared interfaces

- Shell IDs: `connection-status`, `refresh-button`, `main-content`, `view-overview`, `view-issues`, `view-settings`, `issue-dialog`, `issue-detail`, `close-issue`, `toast`, `app-message`. Navigation buttons use `data-view="overview|issues|settings"`; dialog title created by app is `issue-title`.
- `lib.js`: exports `createApiClient({onUnauthorized}={})` yielding `request(path,{method,body,signal}={})` with `/api/admin` prefix, JSON body serialization, same-origin credentials/no-store/redirect rejection/timeout and safe `ApiError.status/retryAfter`; `formatNumber`, `formatPercent`, `formatDate`, `relativeTime`, `buildDebugPrompt(detail,report=detail.latest_report)`, `safeGithubUrl`, `queryString`, `dateRange(days=30)`.
- `push.js`: exports `mountPushManager(container,{request,notify})` returning `{dispose()}`. Owns its DOM, service-worker registration, permission/subscribe/sync/unsubscribe/test and subscription list. No permission prompt until explicit click; `notify(message,kind='info')` reports outcomes. Calls relative API paths `/push/*` through injected request.
- `app.js`: imports the helpers above, owns overview/issues/settings/dialog rendering, navigation, date/filter state, pagination, clipboard, lifecycle/mute mutations and release comparison. Calls `mountPushManager` for settings.
- Overview gains `alerts:{window_seconds,spikes:[{issue_id,category,status,report_count,distinct_installs,last_seen_at}]}` from actual bounded D1 aggregate data; client labels this as a live detection window.

## Task 1: Shell and installable visual foundation

- [x] Build complete HTML/CSS, manifest and local SVG/PNG app icons using the design tokens and shared DOM IDs.
- [x] Include viewport/safe-area/dark-mode/Apple installation metadata, accessible navigation/dialog/status/skip link and no-JS guidance.
- [x] Pin Tailwind CDN and integrity; keep a complete local CSS foundation when the CDN is unavailable.
- [x] Verify responsive layout and manifest/icon references.

## Task 2: Push manager and service worker

- [x] Write failing meaningful push/service-worker tests, then implement explicit permission, subscription synchronization and test results.
- [x] Handle unsupported/denied/non-standalone/offline/auth-failed/expired subscriptions and VAPID rotation without silently destroying a working subscription.
- [x] Implement bounded push display, badge updates and validated same-origin notification actions/deep links, with no private-response caching.
- [x] Verify malformed payloads, external URLs, existing-window focus and provider/API failures.

## Task 3: Dashboard behavior and shared API boundary

- [x] Write failing API/prompt/spike tests, implement safe shared helpers and real D1 live spike summaries.
- [x] Build overview release metrics, weighted success/fallback rates, before/after comparison and honest live alert banners.
- [x] Build issue search/multifilter/pagination, detail sheet with environment, timeline/waterfall, DOM/API evidence, stack and report history.
- [x] Build lifecycle/fixed-version/GitHub/mute controls and exact Copy AI Debug Context flow with a manual-copy fallback.
- [x] Verify abort/race/auth/error states and injection-safe rendering using browser interactions.

## Task 4: Integration, review and delivery

- [x] Run diagnostics tests/typecheck, Worker dry run and relevant existing extension checks.
- [x] Exercise mobile and desktop browser flows with API fixtures and actual Worker contracts; inspect screenshots and fix layout defects.
- [x] Independently review and resolve actionable defects, including push/auth/private-cache boundaries.
- [x] Update README and deliver complete unabbreviated Phase 4 source snapshot, verification results and device/deployment limits.

## Completion record — 2026-10-22

- All requested PWA entrypoints and supporting CSS/helpers/push module/local icons are implemented without a frontend build step. Tailwind browser 4.3.3 is pinned with verified SHA-384 integrity, and complete local CSS works when CDN requests fail.
- `npm run check`: generated binding types, strict TypeScript and all 220 diagnostics tests passed.
- `npm run test:browser`: all 7 Chromium tests passed against the real Hono router, SQLite schema and genuine RSA Access assertions using labelled synthetic fixtures. Verified 320/390/1440px layouts, actual Tailwind loading/CSP and CDN failure fallback, live metrics/comparison, filters, selected report evidence, hostile strings, clipboard fallback, deep links, modal feedback, stale lifecycle conflicts and real manual Access redirects.
- Worker dry run succeeded with all 16 asset-directory entries; bundle 960.97 KiB / 168.71 KiB gzip. No remote deployment occurred.
- Existing extension `npm test` and `npm run lint` passed; Chrome/Firefox archives built with existing source unchanged.
- Independent review identified and verified fixes for three important defects: real Access redirects failing to clear sessions, stale lifecycle forms overwriting newer regressions, and success feedback hidden behind native modal sheets. Focused review checks passed with no remaining important findings.
- Additional meaningful regressions cover late push initialization, current report/history/comparison races, malformed push fallbacks, hostile notification links, badge failures and server registration/removal failures.
- Visual QA fixed compact issue dates, alert row overflow at 320px, evidence spacing and timeline state colors. Final screenshots are in `diagnostics/.wrangler/browser-qa/`.
- Full source delivery: `docs/diagnostics-phase-4.md`; setup, HTTP/precondition contracts, Home Screen guidance, private-cache behavior, best-effort notifications and physical-device limits are documented in `diagnostics/README.md`.
- Development dependencies now explicitly include pinned jsdom and Playwright; runtime dependencies remain the approved seven libraries. The synthetic preview is development-only and was stopped after QA.
- No live push/Discord delivery, real account/domain/Access policy change, deployment, or commit was performed. iOS 27 installation, APNs delivery, lock-screen UI, badges, authenticated background asset fetching and deployed latency require actual deployment/device validation.
