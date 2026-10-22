# Diagnostics system: Phases 1–4

This independent package contains the complete private diagnostics system: configuration, schema, privacy and delivery services, Hono API, and the buildless mobile PWA dashboard. The existing extension and deployed `../relay/` keep their current contracts.

The Worker API and Phase 4 PWA are implemented. Deployment requires your real domain, Cloudflare Access application, D1 database, and secret bindings; no remote deployment has been performed.

## Directory structure

```text
diagnostics/
  .gitignore
  README.md
  package.json
  package-lock.json
  tsconfig.json
  wrangler.toml
  schema.sql
  examples/
    send-report.ts
  public/
    .assetsignore
    index.html
    app.css
    app.js
    lib.js
    push.js
    sw.js
    manifest.json
    icons/
      icon.svg
      icon-192.png
      icon-512.png
      apple-touch-icon.png
      maskable-512.png
      badge.svg
      badge-96.png
  src/
    index.ts
    http/
      types.ts
      config.ts
      security.ts
    routes/
      admin.ts
    schemas/
      ingest.ts
    utils/
      sanitize.ts
      fingerprint.ts
    services/
      ruleEngine.ts
      delivery.ts
      notifications.ts
      ingestion.ts
  test/
    helpers/
      d1.mjs
      access.mjs
      preview-server.mjs
    admin.test.mjs
    api.test.mjs
    delivery.test.mjs
    example.test.mjs
    fingerprint.test.mjs
    ingest.test.mjs
    ingestion.test.mjs
    notifications.test.mjs
    ruleEngine.test.mjs
    sanitize.test.mjs
    schema.test.mjs
    security.test.mjs
    dashboard-lib.test.mjs
    dashboard.test.mjs
    push.test.mjs
    sw.test.mjs
    browser/
      pwa.test.mjs
```

`npm run cf:types` generates the ignored `worker-configuration.d.ts`. Dependencies and local database state live in ignored `node_modules/` and `.wrangler/` directories.

All four authorized phases are delivered. Supporting CSS, shared API helpers and push settings are separate files to keep the requested entrypoints readable. Static assets require no frontend build step.

## Installation and local verification

Use Node.js 24 or newer. The tests use Node's built-in test runner, native TypeScript stripping, and SQLite; these development APIs are never imported into the Worker. The runtime schemas and extension example use the requested libraries and standard Web APIs.

Run from this directory:

```powershell
npm ci
npm run check
npm run cf:types
npm run db:init:local
```

`schema.sql` is the canonical initial schema. It uses idempotent creation statements and can initialize an empty local D1 database. Later schema changes require explicit migrations; reapplying this file does not modify existing table definitions. Do not wrap it in `BEGIN`/`COMMIT`: D1 manages its own transactions.

## Configuration and secrets

All seven runtime dependencies requested in the brief are pinned in `package.json`, with a committed npm lockfile. `wrangler.toml` declares `DB` and `ASSETS`, uses the current compatibility date, and enables `run_worker_first = true` for every static asset. No Node compatibility flag is enabled.

`workers_dev = false` and `preview_urls = false` avoid alternative public URLs. Configure the real custom domain and Access application before publishing the server/dashboard in their later phases. No domain, account ID, database UUID, webhook, or VAPID key is invented here. D1's ID is omitted using Wrangler's supported automatic provisioning; the resource is created only when an authorized deployment actually runs. To use a pre-created database instead, set the real `database_id` returned by Cloudflare under `[[d1_databases]]`.

The following runtime environment names are declared in `[secrets].required`; their values stay outside source control. Account-specific public settings also use secret bindings so that configuration has no fake values:

| Binding | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | Base64url P-256 application-server public key |
| `VAPID_PRIVATE_KEY` | Matching base64url P-256 private key |
| `VAPID_SUBJECT` | Your actual `mailto:` contact or HTTPS contact URL |
| `DISCORD_WEBHOOK_URL` | Your private Discord incoming webhook URL |
| `CF_ACCESS_TEAM_DOMAIN` | Your actual team hostname ending in `.cloudflareaccess.com`; Phase 3 extracts the team name expected by the middleware |
| `CF_ACCESS_AUD` | The audience tag for the private Access application |
| `RATE_LIMIT_HASH_SECRET` | A separately generated random secret for HMAC hashing IP rate-limit subjects |

For local development, put the real values in an ignored `.dev.vars` file beside `wrangler.toml`. Before a later deployment, set the same names through Cloudflare's encrypted secret configuration. For example, Wrangler's interactive commands are:

```powershell
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put RATE_LIMIT_HASH_SECRET
```

These commands are setup instructions for a later deployment; none were run during Phase 1. `secret put` can create/deploy a Worker version, so use the dashboard or the appropriate version workflow when coordinating an existing deployment. Never paste secret values into shell command arguments or commit `.dev.vars`.

The Access application must protect the dashboard and `/api/admin/*`; only the exact public ingest and heartbeat paths may bypass the edge login challenge. The Worker verifies the Access JWT's signature, issuer, audience, expiry, not-before and issued-at claims using `@hono/cloudflare-access` before serving protected APIs or assets. Configure Access to forward `Cf-Access-Jwt-Assertion`; a `CF_Authorization` cookie alone is rejected. Configure the permitted owner identity and required MFA/passkey policy in Access. Extension-origin CORS is a browser boundary, not client authentication.

## Payload contract

`src/schemas/ingest.ts` exports `errorReportSchema`, `heartbeatSchema`, their input/output types, reusable dimension schemas, and the fixed `MAX_BODY_BYTES = 65_536` limit. Objects reject unknown properties. No numeric coercion is used.

Error reports require explicit `consent: "diagnostics-v1"`; heartbeats require separate `consent: "telemetry-v1"`. These declarations are an ingestion contract, not proof of consent: the extension must read its actual opt-in setting before preparing, queuing, and sending data. The legacy automatic-error-report preference does not automatically authorize heartbeat telemetry.

Create a cryptographically random installation seed in extension-local storage only after consent. Send only its lowercase SHA-256 digest as `install_id`. Never hash an email, account ID, username, Nexus API key, or hardware/browser fingerprint. This pseudonymous identifier counts installations, not people. Clear queued data on opt-out and delete the seed when resetting diagnostics identity; keep it stable across ordinary retries and extension updates.

Versions use full SemVer, including valid prereleases/build metadata, with safe numeric precedence components. Client `occurred_at` values must be real UTC dates on or after the Unix epoch in the canonical `YYYY-MM-DDTHH:mm:ss.sssZ` format. Daily `metric_date` values use actual UTC calendar dates. These client timestamps never determine spike or canary windows.

Browser families are `chrome`, `edge`, `firefox`, `safari`, `opera`, `brave`, or `other`. Operating systems are `windows`, `macos`, `linux`, `android`, `ios`, `chromeos`, or `other`. Destinations are `browser`, `vortex`, or `mo2`; download modes are `manual` or `auto`. Browser/OS versions are separate bounded fields rather than full user agents.

Reports carry original `error_category`, `error_code`, and `failure_stage`. The server computes normalized frames, fingerprints, derived classification, and suggested actions. Clients cannot supply issue status, fault origin, fingerprint, classification, server timestamps, or notification decisions.

Breadcrumbs are nondecreasing offsets from the start of the operation, with at most 80 entries. Optional durations are elapsed milliseconds. HTTP statuses must be integers from 100 through 599. Metadata allows finite JSON values with at most three container levels including the root record, 32 keys per object, 16 items per array, 48 characters per key, and 1,024 characters per string. Dangerous prototype keys are rejected before record parsing. DOM state contains readiness, selector match summaries, and optional API schema field summaries; it cannot contain arbitrary HTML or headers.

The explicit `context.api_endpoint` must be HTTPS and contain no credentials, query string, or fragment. All validated strings and metadata remain untrusted: call the Phase 2 sanitizer before persistence, logging, or forwarding. Fingerprinting also sanitizes its emitted frames and grouping dimensions. Schema validation alone does not sanitize diagnostic text.

The schema checks UTF-8 bytes of the parsed representation. The API also counts the actual request stream before JSON parsing, capped at 65,536 bytes without trusting `Content-Length`. This catches oversized whitespace and chunked payloads. It accepts UTF-8 `application/json` and rejects content encodings. Valid client event dates can be backfilled; server receipt time alone drives rate, spike and canary decisions. Heartbeat receipts must be retained while their historical aggregates are retained.

## Database write contract

All SQL timestamps use integer UTC epoch milliseconds. The Worker supplies `created_at` from its own clock and converts validated `occurred_at` to epoch milliseconds. Spike queries use server `created_at`. Rule classification snapshots belong on reports; issue classification is the current summary. Original fingerprint inputs remain separate when an upstream canary changes the derived category.

Map payload `report_id` to `reports.id`. The schemas normalize UUIDs to lowercase before persistence so casing cannot create a second retry identity. Store the sanitized breadcrumbs, DOM state, and context as JSON strings; omit optional scalar fields as SQL `NULL`. Issue IDs are database-generated integers. Use bound parameters for every user value and atomic D1 batches for related writes.

Use targeted conflict handling for immutable request identities. `ON CONFLICT(id) DO NOTHING` is suitable for a report retry; broad `INSERT OR IGNORE` can hide unrelated constraint failures. Never `INSERT OR REPLACE` an issue, since replacement can cascade-delete its children. The insertion triggers, not application-side read/increment sequences, own occurrence counts, distinct installation membership, observation times, and release rollups.

`total_occurrences` and `affected_installs_count` are lifetime counters. Detailed reports can be purged without reducing these counters. Retain issue memberships and report receipt tombstones for the issue's lifetime so replaying an old report cannot inflate them. Deleting an issue intentionally deletes its associated data and deduplication history.

Heartbeat counters are immutable **deltas**, grouped by UTC date, version, browser, and destination. One logical batch gets one `heartbeat_id`, retained with its exact body for retries. Never resend daily cumulative totals as fresh batches. `success_count` and `fallback_triggered_count` must each be at most `attempts_count`; they can overlap because a successful attempt can use a fallback. `heartbeat_receipts` preserve retry identities and atomically roll up each accepted delta once. Keep receipts for the lifetime of the aggregate until a bounded historical acceptance policy is implemented. The API must reject reuse of an ID with altered contents.

`status` is one of `new`, `investigating`, `fixed`, `regressed`, or `ignored`. Independent `muted` state suppresses notifications without losing workflow state. Fixed and regressed issues require `fixed_in_version`; chronological first/last observed versions must never be calculated using SQL text `MIN`/`MAX`. Phase 3 uses `compare-versions` for regression decisions.

Rate-limit buckets store HMAC subject hashes, scope, window, count, and expiry; no raw IP column exists. Include the exact route and scope in the HMAC input, encoded as an unambiguous tuple, to keep ingest and heartbeat limits separate. Notification claims support unique event identities and bounded delivery leases so concurrent ingests can reserve delivery atomically. `last_pushed_at` describes successful delivery, not merely a reservation. Push endpoints and subscription keys are private credentials accessible only through protected admin paths.

## Extension example

`examples/send-report.ts` contains complete `prepareExampleReport()` and `sendPreparedReport()` functions. The caller supplies its real relay origin, persisted random installation seed, release/browser/OS values, and current consent. Preparing generates one report identity and a SHA-256 installation hash; the returned immutable object is reused for retries. Sending checks current consent, omits credentials, rejects redirects, and applies a ten-second timeout. It holds no webhook, Access token, or VAPID private key.

The example is TypeScript intended for the extension's build/background context and imports the shared Zod schema. It is not injected into the existing dependency-free extension in this phase. A later integration must add the actual relay origin to extension host permissions and map real events to the schema. Run network delivery from the extension context rather than the Nexus page's origin.

## Phase boundary and operational limits

No remote resources, secrets, extension preferences, or Access policies were created or changed. Delivery tests use generated local keys and mocked HTTP boundaries. All four phases are implemented. The tracked `.assetsignore` excludes hidden files from the published asset directory.

The requested sub-50 ms ingest response is a performance target to measure after the complete D1 path exists, not a guarantee Phase 1 can establish. `waitUntil()` moves delivery out of the response path but is not a durable delivery queue; later delivery code must describe and handle its failure semantics.

## Phase 2 service contracts

| Module | Exports and behavior |
| --- | --- |
| `src/utils/sanitize.ts` | `sanitizeText`, `sanitizeUrl`, `sanitizeDeep`, `sanitizeReport`, and `REDACTED`. Non-mutating bounded redaction; returned reports still satisfy the ingest schema. |
| `src/utils/fingerprint.ts` | `normalizeStack`, `normalizedTopFrame`, `sha256`, `fingerprintReport`. Parses Chrome/Firefox/Safari stacks with `error-stack-parser-es`; returns the normalized stack/top frame and lowercase SHA-256 digest. |
| `src/services/ruleEngine.ts` | `classifyReport` and `evaluateRules`, with `RuleEvaluation`/`FaultOrigin` types. Pure terminal-error classification and read-only D1 canary evaluation. |
| `src/services/delivery.ts` | `buildDiscordMessage`, `sendDiscordReport`, `sendWebPush`, and transport types. Complete RFC 8291 encryption/VAPID implementation through `@block65/webcrypto-web-push`; bounded HTTPS delivery and rich sanitized Discord embeds. |
| `src/services/notifications.ts` | `sendIssueNotifications`, `sendTestNotification`, `reservePushNotification`, `completePushNotification`, `releasePushNotification`, and configuration/result types. Trigger selection, SQL claims, cooldown, bounded fan-out, and expired-subscription cleanup. |

Sanitization covers nested sensitive keys, quoted/escaped JSON and log assignments, header tuples, Authorization/Bearer/Basic values, API/personal keys, session aliases including `X-Session-Id`, `JSESSIONID`, and `PHPSESSID`, URL credentials/query strings/fragments, extension origin IDs, email/IP strings, and Windows/macOS/Linux home-directory usernames including spaces and encoded URL components. Metadata keys and all permitted diagnostic text/identifier fields are checked too. If redacting an identifier or browser/OS version would violate its schema grammar, its replacement is the literal `REDACTED` token. Safe IDs and versions retain their existing values. The anonymous installation hash and immutable request identities remain intact for grouping and replay protection.

The stack parser consumes the original validated stack in memory before sanitizing emitted frame components. This preserves Firefox `function@relative-file.js` syntax that could otherwise resemble an email address. It never returns the raw stack. Extension origins normalize to `extension:///`; query strings and all line/column positions are removed consistently because bundled extensions do not reliably identify which frames are minified. Up to twenty recognizable frames are retained; missing/unparseable stacks use `<unknown>`. Fingerprints hash the JSON tuple `[sanitized original error_category, sanitized original error_code, sanitized original failure_stage, normalized_top_frame, destination]`, excluding derived rule categories and error message text.

The six core classifications preserve the exact Greek suggested actions from the brief. Explicit terminal security/conflict/handoff/rate-limit/structural/network evidence takes precedence over historical context. A recovered primary 429 or old API schema mismatch cannot override a failed fallback handoff/fetch. Isolated API schema mismatches remain `unknown` fault origin; DOM failures remain `client_env` until enough stored installations support the canary. The canary counts distinct installations for the same issue between inclusive server receipt bounds; it returns `UPSTREAM_BREAKING_CHANGE`/`upstream_site` at the configured threshold without modifying stored report snapshots.

### Integration sequence for Phase 3

1. Enforce request-stream size, content type, origin, rate limits, and opt-in payload validation.
2. Compute `fingerprintReport(originalValidatedReport)` while the original stack is available only in memory; create `sanitizeReport(originalValidatedReport)` for persistence and delivery. Never persist or log the original object.
3. Use `classifyReport(sanitizedReport)` for the immutable report's base classification. Atomically create/find the issue and insert the report using the Phase 1 write contract. Only a newly accepted report may schedule delivery.
4. Call `evaluateRules(DB, sanitizedReport, { issueId, now })` after the report is stored, with `now` equal to its server `created_at`. Apply the returned current classification to the issue summary; retained report snapshots keep their base classification at persistence. The current issue evaluation records any later multi-install canary decision.
5. Detect the one `fixed → regressed` transition atomically in the ingestion transaction using SemVer. Pass that transition's immutable event ID as `regressionEventId`; ordinary reports for an already-regressed issue must omit it.
6. Pass the `sendIssueNotifications(...)` promise to `c.executionCtx.waitUntil(...)`. Supply the sanitized report, current rule evaluation, issue ID, new-issue flag, transition ID when applicable, and server decision time. Do not schedule delivery for an idempotent report retry.

`NotificationConfiguration` accepts `dashboardOrigin`, `discordWebhookUrl`, and `vapid: { publicKey, privateKey, subject }`. Optional numeric settings are `cooldownMs` (default 1,800,000), `windowMs` (900,000), `spikeReportThreshold` (10), `distinctInstallThreshold` (3), and `requestTimeoutMs` (5,000 maximum). Convert the matching Wrangler seconds variables to milliseconds when constructing this configuration. Bind the actual secret values at the router boundary; do not store them in report data.

Push priority is regression, upstream change, new critical issue, then spike. A new critical event requires `error`/`fatal` severity; a spike requires ten stored reports and three distinct installations in the detection window. Muted/ignored issues suppress push; Discord still receives each newly accepted report. The service independently verifies report receipt ownership before delivery and verifies that regression reports are newer than the fixed version.

Claims use a random ownership token, a thirty-second lease, a unique event identity, and an atomic conditional SQL insert/update. Normal events share the issue cooldown and active-lease gate. A genuine regression bypasses cooldown; a delivered transition cannot send twice. Completion is an atomic D1 batch guarded by ownership; failure releases only the current owner's lease. An expired worker cannot complete or release its successor's claim. `last_pushed_at` changes only after at least one push provider accepts a message.

Push payloads contain the full fingerprint as `tag`, a provider `Topic` of at most 32 characters, an HTTPS `/?issue=<id>` deep link, badge count, trigger, and issue identity. Regression, new critical, and upstream alerts use high urgency. `sendTestNotification` delivers a test push without creating an issue, sending Discord, or changing issue cooldowns. The protected admin endpoint, device controls and service-worker display are implemented.

### Delivery outcomes and bounds

Both senders return `DeliveryResult` with `ok`, HTTP `status`, `retryable`, `expired`, bounded `retry_after_ms`, and a safe `reason`. Secrets and provider bodies never appear in the result. A successful result means provider acceptance; lock-screen display and user acknowledgement cannot be verified by the sender.

Push endpoints are restricted to HTTPS Apple `*.push.apple.com`, Google `fcm.googleapis.com`, Mozilla `push.services.mozilla.com` and its subdomains, and Microsoft `*.notify.windows.com`. Other providers require an intentional allowlist extension. The service validates canonical base64url key sizes/curve points, matching VAPID keys and contact subject, encrypted plaintext size, URL authorities, and expiration. It does not follow redirects. HTTP 404/410 subscriptions are removed only when their stored endpoint and keys still match the attempted values, protecting concurrent key rotation. Cleanup failures do not abort other sends or discard accepted-delivery cooldowns.

Discord accepts validated Discord-owned incoming webhook URLs, uses `wait=true`, disables all mentions, and clips Unicode safely within Discord embed limits. It includes a selected diagnostic summary, environment, suggested action, recent timeline, bounded stack, fingerprint, and issue link; installation IDs stay out of embeds.

HTTP attempts time out within five seconds and do not read unbounded response bodies. Retryable provider responses include a bounded `Retry-After` duration of at most 24 hours. The transports do not sleep or automatically retry; callers receive the outcome. Push fan-out uses four workers, an eighteen-second work budget, and at most 100 subscriptions per dispatch. Unattempted/failed deliveries are reported; partial acceptance starts cooldown to avoid resending successful devices. Every started worker settles before a claim is completed or released, and Discord's promise settles independently of push bookkeeping failures.

Delivery uses `waitUntil` best effort rather than a durable queue. Failed all-device sends release the claim and remain eligible for a later explicit retry, but this phase creates no background retry scheduler. Discord has no persisted channel-specific delivery receipt; the ingestion transaction must invoke it once per newly accepted report. An interrupted request/provider timeout can still have an uncertain delivery outcome. Durable exactly-once external delivery is not claimed.

## Phase 3 HTTP API

Only exact `/api/ingest` and `/api/heartbeat` paths are public. They require a canonical Chrome extension origin or Firefox UUID extension origin, even for non-browser clients. Preflight permits only POST with `Content-Type`; credentials are not allowed. Chrome content scripts must send through the extension background context. Both routes return HTTP 202 for a newly stored payload and HTTP 200 with `duplicate: true` for an identical retry. Reusing a retained identity with different data returns HTTP 409. Responses include only the submitted report/heartbeat ID, success flag and duplicate flag.

The public middleware consumes the trusted Cloudflare `CF-Connecting-IP` budget before body parsing and the validated installation budget before full payload validation. Missing or malformed connecting IP is rejected. Default per-minute limits are 60 IP / 20 installation reports and 120 IP / 10 installation heartbeats. Atomic fixed-window D1 buckets contain HMAC-SHA-256 hashes of `[route, scope, subject]`; raw IPs and admin identities are never stored in buckets. Denials return HTTP 429 with `Retry-After`. New buckets perform bounded expired-bucket cleanup. Fixed windows permit bursts across a window boundary; origin checking does not authenticate an extension installation.

Every other path, including unknown APIs and static assets, requires the signed Access assertion. Protected mutations also require an `Origin` equal to the request's HTTPS origin. Responses are `Cache-Control: no-store` with content-type sniffing, framing and referrer restrictions. Unknown API paths return JSON 404 instead of a SPA response. Access verification uses a bounded cache of vendor middleware instances; the pinned middleware owns its trusted JWKS request and exposes no timeout or response-size hook. A JWKS outage fails authentication closed; it can delay the request until the platform network limit.

| Method and protected path | Contract |
| --- | --- |
| `GET /api/admin/overview` | Issue totals, aggregate release health and bounded live spike alerts |
| `GET /api/admin/issues` | `{items,total,page,limit}`; filters `version`, `browser`, `os`, `destination`, `download_mode`, `status`, `fault_origin`, `category`, `severity`, `muted`, `q`, `from`, `to` |
| `GET /api/admin/issues/:id` | `{issue,report_summary,latest_report}`; JSON diagnostic fields are parsed |
| `GET /api/admin/issues/:id/reports` | Bounded report pagination |
| `PATCH /api/admin/issues/:id` | Nonempty partial update of `status`, `fixed_in_version`, `github_issue_url`, `muted`; optional original `expected` snapshot; conflicts return 409 |
| `GET /api/admin/releases` | Aggregated release counters and nullable percentages, with version/date/browser/destination filters |
| `GET /api/admin/releases/compare?before=3.1.0&after=3.2.0` | Before/after aggregates and percentage-point deltas, with date/browser/destination filters |
| `GET /api/admin/push/config` | `{public_key}`; never returns private VAPID material |
| `GET /api/admin/push/subscriptions` | Subscription metadata; endpoints and key material remain private |
| `POST /api/admin/push/subscriptions` | Native PushSubscription JSON `{endpoint,expirationTime,keys:{p256dh,auth}}`; returns metadata, 201 new / 200 updated |
| `DELETE /api/admin/push/subscriptions/:id` | HTTP 204 on deletion, 404 when absent |
| `POST /api/admin/push/test` | Strict empty JSON object; delivery summary; one request per minute per verified identity |
| `GET /api/admin/health` | Protected D1 readiness check |

Issue dimensions must match the same retained report. Lists default to page 1 / limit 30 and allow at most 100 rows per page and page 10,000. Date filters use real UTC calendar dates, default to the last 30 days, and permit a maximum 366-day inclusive range. Unknown or duplicate query keys are rejected. Text search escapes SQL LIKE wildcard characters and uses bound parameters. Release percentages and deltas are `null` when their denominator is zero.

Fixed or regressed issues require a valid SemVer baseline. GitHub links must be HTTPS `github.com/<owner>/<repo>/issues/<positive number>` with no credentials, query, or fragment. The independent mute flag suppresses push. Push registration verifies an allowed provider URL and actual P-256 curve point before writing, sanitizes the user-agent, caps the database at 100 subscriptions atomically, and permits existing endpoint key rotation at capacity.

Report creation, immutable retry receipt, distinct installation membership and lifetime counters commit as one D1 batch. Heartbeat receipt insertion and release rollup also commit atomically. Replay bodies are never inserted, so retention cannot restore deleted details or inflate counters. When report details still exist, canonical sanitized bodies must match; after body retention, installation and fingerprint still guard the receipt identity. Only a newly accepted version strictly above a fixed SemVer baseline can atomically create a regression event. Classification enrichment after the transaction is best effort: a failure retains the stored classification and successful acceptance. The issue summary refresh reads the latest retained report's immutable base classification and counts the current receipt window in one atomic SQL statement, so delayed requests cannot overwrite newer evidence or leave a canary undetected.

Discord and eligible push delivery are scheduled through `waitUntil()` only for newly accepted reports. Push window and claim decisions use the later of this request's receipt clock and the issue's latest receipt clock; out-of-order commits cannot hide the third installation's canary or a current spike. Discord retains this report's own sanitized context. Notification failures cannot roll back persistence or change an accepted HTTP response. Logs contain fixed event names and random request IDs, without payloads, tokens, SQL errors, provider bodies or URLs. Response latency still includes body validation, HMAC rate checks and D1 writes; the requested 50 ms target needs measurement on the deployed domain and region. No durable queue or automatic retry worker has been introduced.

Local builds can be checked without deployment:

```powershell
npm run check
npx wrangler deploy --dry-run --outdir .wrangler/phase3-dry-run
npm run db:init:local
```

`npm run typecheck` first regenerates the binding types. A dry run bundles the Worker but does not verify your real Access policy, secrets, Discord delivery or device push display.

For local ingest, run `npx wrangler dev --local-protocol https` with the real ignored development bindings. Notification links require HTTPS, including in local requests. Local admin access still requires a valid Access assertion; the Worker has no development authentication bypass.

## Phase 4 dashboard

Open the configured HTTPS domain after authenticating through Cloudflare Access. Overview shows attempt-weighted success and fallback rates, release counters and before/after percentage-point changes. Empty denominators display unavailable rates. The live detection panel is explicitly independent of the historical UTC date filter: `alerts.window_seconds` is the configured detection window, and `alerts.spikes` contains at most five current unmuted, non-ignored issues meeting both the report and distinct-install thresholds. Browser and destination filters also apply to these alerts. Historical issue totals are labelled “Issues in window,” including fixed issues.

Issues supports search, version, browser, OS, destination, download mode, status, fault origin, category, severity, mute state and UTC date filters, with bounded pagination. Each issue opens in a native modal sheet containing lifetime counts, current rule output, retained environments, lifecycle controls, report history, the selected report's environment and immutable classification, full timeline/waterfall, HTTP status/durations, metadata, DOM/API evidence, network context and stack. Select an older retained report to inspect or copy that exact report. Missing retained details are shown explicitly.

Lifecycle saves send only changed fields together with `expected: {status,fixed_in_version,github_issue_url,muted,updated_at}` from the displayed issue. The server rejects stale snapshots with 409, even if a newly ingested regression changed status within the same millisecond. Refresh the details and review the new state before retrying. Existing API clients can omit the optional snapshot, but the dashboard always supplies it. An `expected` object alone is not an update.

“Copy AI Debug Context” creates a complete Markdown prompt with original grouping data, current and report-time classifications, affected browsers/releases, selected environment, exact breadcrumbs, DOM/API state and stack. Subscription credentials and anonymous installation hashes are excluded. Diagnostic content is labelled untrusted and fenced safely even if it contains Markdown fences. Clipboard success appears inside the modal; browsers that deny clipboard access get a selectable complete-text fallback.

Navigation, filter changes, detail requests, report history and comparisons use aborts and generation checks so late results cannot overwrite the current view. HTTP 401/403, HTML login responses and manual redirects invalidate the session and clear private view/detail data. The API client does not follow Access redirects or read bearer cookies. Reopen the root page to sign in again. Offline/network errors offer retry without pretending that an empty result is live data.

### Install and enable notifications on iPhone

1. Open the real HTTPS dashboard in Safari and finish Access sign-in.
2. Use Safari's Share menu, choose **Add to Home Screen**, and open the installed Diagnostics app. The manifest requests standalone display with local application and maskable icons.
3. Open **Settings**. Registration of the push-only service worker and retrieval of the public VAPID key happen there; permission is not requested automatically.
4. Tap **Enable on this device** and respond to the system notification prompt. The permission request occurs directly in that click gesture; `PushManager.subscribe()` uses `userVisibleOnly: true` and the application-server key.
5. Tap **Send test notification**. The result distinguishes provider acceptance, partial failure, no registered devices and failed delivery. It sends to all registered devices and is capped at one request per minute per verified identity.

Home Screen installation and a direct user action for notification permission follow [WebKit's Web Push guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). The UI detects capabilities rather than assuming a browser version. iOS 27 is the requested target; real installation, native permission behavior, Access session continuity, APNs delivery, lock-screen presentation, badges and notification opening have not been tested on a physical iPhone in this workspace.

An existing browser subscription can be explicitly synced to the server. If server registration fails, the local subscription is preserved for retry. Disabling removes the server registration before the browser subscription; an API failure keeps recovery possible. VAPID-key replacement is a separate deliberate action. Denied permission and non-standalone iOS browsers receive guidance. Device lists contain metadata only; endpoints and encryption keys are not displayed. Current-device identity is established through a protected sync rather than persistent client credentials.

The service worker displays a visible bounded fallback for malformed pushes, preserves the full fingerprint notification tag for grouping, and updates supported application badges without allowing a badge error to suppress a notification. Click handling validates the origin, exact root route, issue ID, trigger and fingerprint before focusing/navigating an existing window or opening a new one. Invalid links open the safe root. “Close” does not navigate. See [notification click handling](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/notificationclick_event) and [application badging](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/setAppBadge).

The worker has no fetch handler, response cache or offline app shell. Private API/page data is not written to Cache Storage, localStorage or IndexedDB. A browser-managed service-worker registration/subscription persists as required for push. Updates follow the platform lifecycle; fully close and reopen the app when applying a new service-worker version. Access protects the manifest, icons and service-worker script as well as the UI, so physical-device validation of authenticated installation/update fetches is part of deployment verification.

### Styling and browser verification

The requested Tailwind browser CDN is pinned to `@tailwindcss/browser@4.3.3` with SHA-384 subresource integrity, anonymous CORS and no referrer. Complete local CSS provides the same usable layout when the CDN fails. Tailwind's [Play CDN documentation](https://tailwindcss.com/docs/installation/play-cdn) describes it as a development option; this implementation retains it because the brief explicitly requires CDN Tailwind and no frontend build. No additional runtime dependency was introduced. Static response CSP permits the pinned CDN host and local modules, allows generated styles, and restricts connections, workers, manifests and images to this origin.

Run the browser suite separately after installing its development browser:

```powershell
npx playwright install chromium
npm run test:browser
```

It serves synthetic in-memory data through the actual Hono API, SQLite schema and cryptographically verified test Access JWTs. Chromium covers 320px/390px/1440px layouts, release comparisons, filters, lifecycle persistence and stale conflicts, hostile text, clipboard fallback, real manual Access redirects, native modal feedback, deep links, settings and CDN failure/loading. Screenshots are written to the ignored `.wrangler/browser-qa/` directory. This is browser verification, not a claim of physical iOS or live provider delivery.

For a temporary local preview with clearly labelled synthetic data, run:

```powershell
node test/helpers/preview-server.mjs
```

The helper prints a loopback-only URL and generates temporary RSA/VAPID keys and an in-memory database. No live external notification delivery is enabled. It emulates the Access edge by supplying signed assertions to the unchanged verifier; it does not add a production auth bypass. Stop it with Ctrl+C. Real deployment still uses the actual domain, Access policies and secret bindings described above.

## Official references

- [Wrangler configuration: automatic provisioning and required secrets](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Worker-first static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [D1 foreign-key enforcement](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)
- [D1 database API and atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Zod schema APIs](https://zod.dev/api)
- [WebCrypto Web Push](https://github.com/block65/webcrypto-web-push)
