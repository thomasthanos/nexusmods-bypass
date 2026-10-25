<p align="center">
  <img src="../docs/assets/header-relay.svg" alt="Bug-report relay" width="100%" />
</p>

<p align="center">
  <a href="../README.md"><kbd> ← README </kbd></a>&ensp;·&ensp;
  <a href="../PRIVACY.md"><kbd> 🔒 Privacy </kbd></a>&ensp;·&ensp;
  <a href="../CONTRIBUTING.md"><kbd> 🤝 Contributing </kbd></a>&ensp;·&ensp;
  <a href="../CHANGELOG.md"><kbd> 📋 Changelog </kbd></a>
</p>

<img src="../docs/assets/divider.svg" alt="" width="100%" />


A small Cloudflare Worker that receives reports from the extension's **Send bug report** page (and
the optional, off-by-default technical error reports), checks them, and forwards them to a Discord
channel (and optionally e-mail). The extension never contains the webhook or any other secret.

## Current deployment

Updated on 2026-10-25 at https://nexusmods-bypass-relay.mariosthanos3.workers.dev with the 3.3.2 Worker,
deployed by hand with Wrangler from `diagnostics/` as release-gate.yml would (its deploy jobs skip while the
repository has no `CLOUDFLARE_API_TOKEN` secret). Production version `3c34c5ae-cbe3-4081-9a90-e985edc1356a`
serves 100% of traffic, built from `relay/worker.js` at
<a href="https://github.com/thomasthanos/nexusmods-bypass/commit/85ad408a0157e6033014e5918bdfa20fefbed618"><kbd><code>85ad408</code></kbd></a>
(release 3.3.2, `RELAY_EXTENSION_VERSION` 3.3.2). It replaced `985d392e-7b4f-40c0-b4b3-a20ad9efcbc9` (2026-10-24).
The `DIAGNOSTICS` binding reaches the diagnostics Worker version `05fc660d-8a19-465b-9cc1-4c1d293632a2`,
deployed from the same commit just before it (no D1 migration was pending). The existing secrets, CORS
origins and KV binding were inherited; no secret value was retrieved or replaced.

Live checks passed: health returned `ok: true, configured: true` (HTTP 200). An automatic report whose
frame names a function (`probeFunction@content/ndc.js:1:2`) now passes the frame check and stops at a
deliberately invalid timestamp (422 `bad timestamp`; the previous version answered 422 `bad error frame`),
the frame form without a function still passes, and a frame with an invalid function name is still refused.
An empty report through `/v1/diagnostics` reached the diagnostics Worker over the service binding and was
rejected there (400). No report was delivered to Discord or stored for these checks.

`RELAY_CONFIGURED` is enabled in the extension. The deployed Worker already allows extension
origins through CORS. The 3.1.1 and 3.1.2 extensions use ordinary CORS requests without asking for a relay
host permission; earlier releases request the optional permission. KV-backed rate limiting and auto-report dedupe use the `RATE_LIMIT` binding in
`wrangler.toml`. KV is eventually consistent: this shares counters across instances but does not
provide a strict atomic limit. E-mail is not configured.

## Deployed 3.1.1 reporting update

The 3.1.1 extension uses a durable opt-in queue with the deployed schema-1 relay. Discord automatic-error embeds include the shared error reference, occurrence count, observation times, redacted technical cause and packaged script position. Manual and automatic reports have separate rate-limit allowances. User preferences were not changed; declining the invitation keeps automatic reports off. The test suites use mocked destinations and send no live Discord messages.

The previously reported HTTP 403 / Cloudflare code 1010 did not reproduce in the live browser checks. No Cloudflare security settings were weakened, and the historical incident is not claimed as fixed.

## Deployed 3.1.2 reporting update

The Worker update is deployed independently of the extension packages.
Automatic reports use the title `Automatic report`, while manual reports retain `Bug report`.
The red user-report branding and configured maintainer are retained. The same fault/version is
forwarded at most hourly, or every six hours for network/timeout errors. An automatic fault/version
can mention the maintainer once in 24 hours; manual reports retain their explicit notification.
Both windows live in the existing `RATE_LIMIT` KV binding, with per-isolate memory as a fallback.
Counters are occurrences in the forwarded client report, not unique users or global totals.
Optional `error.causeCode` is backwards compatible with schema 1 and lets security-blocked files be
labelled explicitly. Older clients' blocked-file messages are also recognised. No browser or
antivirus block is bypassed. Test destinations are mocked; no live Discord message is sent.

To redeploy, install the relay's pinned Wrangler with `npm ci -w relay` at the repository root,
authenticate with Cloudflare and run `npx wrangler deploy` from `relay/`.
Keep the existing `DISCORD_WEBHOOK_URL`, `REPORT_MENTION_USER_ID`, CORS origins and `RATE_LIMIT` binding.
Do not rotate or overwrite the existing destination secret just to update the Worker.

## What the updated Worker does
- `POST /v1/report`, JSON only, at most 64 KB, schema version 1 (see `validateReport` in `worker.js`).
- At most 10 reports **of each kind** per IP per hour, so automatic reports cannot exhaust the manual allowance. With a KV namespace bound as `RATE_LIMIT` the counters are
  shared across Cloudflare's edge. Without one, a per-isolate in-memory limiter only slows down bursts.
  For a hard limit, add a Cloudflare Rate Limiting rule on the route. No Durable Object is needed.
- Posts one compact Discord embed for automatic errors, with a plain-language explanation,
  page type/action context, a short browser name, an error reference shared with manual reports, occurrence count, observation times, technical cause and packaged script position. Automatic errors include an allowlisted JSON attachment with its preview hidden.
- Embed colours follow severity: manual bug reports and failed extension actions are red
  `#ED4245`; network conditions and Nexus page or API drift are amber `#E8B339`. Titles distinguish
  `Automatic error`, `Automatic warning` and `Bug report`, with a distinct sender name.
  `REPORT_MENTION_USER_ID` in `wrangler.toml` allows one explicit maintainer mention; it is a public
  Discord user ID, not a secret. Report input cannot choose recipients, mention roles or ping everyone.
- Only what needs a person pings: every manual bug report, and an `Automatic error` from a client at
  or above `RELAY_EXTENSION_VERSION` (once per fault and version in 24 hours). An `Automatic warning`,
  or any report from an older client, is posted without a ping (`mentionWorthy` in `worker.js`).
- Manual bug reports still include the full JSON file, preserving the description, reproduction
  steps, expected result and reviewed diagnostics. Mentions from report text are disabled for both report types;
  only the configured maintainer may be pinged.
  If Resend is configured, it also e-mails the same attachment (allowlisted for automatic reports).
- CORS only for extension origins (`ALLOWED_ORIGINS`).

GitHub automation is separate: its sender is `NexusMods Bypass · GitHub`, titles start with `GitHub`,
repository changes/issues are blue, releases green `#57F287` and permission/schema warnings amber.
Workflows post through `node tools/discord-notification.mjs <kind> [summary] --send`, which uses the
same dispatcher as the Worker, waits out Discord rate limits and turns a failed post into a workflow
warning instead of a failed job. It does not
ping the report recipient. Manifest summaries use Discord-friendly bullets; missing/invalid Firefox
manifests are reported as unavailable, never as an unchanged `? → ?` comparison.

## Automatic report diagnostics

Automatic reports have one compact embed (context, technical cause and diagnostic summary) and a
`SPOILER_nexusmods-auto-report-<id>.json` attachment, to keep the JSON preview hidden until opened.
Failed actions are red; page/schema checks and network conditions are amber warnings. Older clients
are identified relative to `RELAY_EXTENSION_VERSION` in `wrangler.toml`, not claimed fixed. Update this
comparison baseline when deploying the relay for a new extension release. Missing configuration is
reported as unknown age, not a guessed old/current version. Unknown extra fields such as contact or
settings are not forwarded in automatic attachments or the email fallback. Manual JSON stays exact.

Basic opt-in sends no extra logs or file IDs. A separate **Include extra diagnostics automatically**
choice on the report page (off by default) enables an optional
`diagnostics: { consent: "extended-v1", file?: { expectedId?, receivedId? }, logs: [...] }`.
Logs are bounded to twenty redacted entries of the same page type from the two minutes before the
incident, captured locally at that time, not when a retry is sent. IDs are public file identifiers,
never account IDs or signed links. The relay validates the complete optional structure before delivery.
Disabling either choice aborts delivery where possible and clears pending diagnostics. Existing rate
limits, deduplication and notification cooldowns are unchanged.

## Copy for the private dashboard

Every automatic report from an extension page that passes validation and the rate limits is also sent,
through the `DIAGNOSTICS` service binding, to the diagnostics service's `/api/ingest/automatic`. The
copy goes ahead of the Discord duplicate check, so the dashboard counts repeats that Discord groups into
one message. `dashboardReport()` writes the dashboard's own fields the way the extension's
private-dashboard reporter does, so a fault groups into the same issue from either path, but without an
installation identifier or OS, which only that separate consent covers. Its report id is derived from
the content: a client's retry reaches the same dashboard report. The copy runs under `waitUntil` with a
ten-second limit and never changes the response; a failure logs `dashboard_copy_failed` with the error
code, version and status, never report text. Manual reports are not copied, and the dashboard does not
post copies to Discord again. `test/relay-diagnostics-test.mjs` and the diagnostics package's
`test/relay-contract.test.mjs` cover both sides.

## Delivery and failure handling

Not yet deployed: run `npx wrangler deploy` from `relay/` to apply it. Wrangler bundles
`worker.js` with `discord.js`, the dispatcher it shares with the GitHub workflows.

- **Discord rate limits:** a 429 is waited out inside the request when Discord asks for a short pause
  (`retry_after` from the body, else `Retry-After`, plus jitter); 502/503/504 and network failures get
  jittered exponential backoff. At most three attempts within nine seconds, inside the extension's own
  timeouts. A longer limit is returned to the client as `429 {"error":"upstream rate limited"}` with
  Discord's `Retry-After`, so the automatic-report queue pauses for exactly that long. Anything else
  Discord refuses (an invalid payload, a deleted webhook) is not retried.
- **Never a bare 500:** every unexpected throw is answered with CORS headers, so the extension sees a
  status it can act on instead of "Failed to fetch".
- **KV is best effort:** a failed read or write (the free plan's daily write cap, or two writes to
  one key within a second) falls back to per-isolate memory instead of refusing the report.
  Bookkeeping after a successful delivery cannot fail the request and cause a duplicate post.
- **Fallback log:** when Discord does not take a report, or KV or e-mail fails, the Worker writes one
  JSON line to its log (`npx wrangler tail`, or Workers Logs if you enable `[observability]`). Lines
  carry the report id, kind, error code, version, HTTP status and attempt count only: no report text,
  no IP address, and the webhook URL and API keys are removed from any error message. If Resend is
  configured the e-mail copy is still sent, so it is the fallback destination.
- **Valid text:** embed text is clipped without splitting emoji, and lone UTF-16 surrogates from a
  client are replaced, because either makes Discord reject the whole message.
- **Bounded input:** bodies without a `Content-Length` are read in chunks and refused past 64 KB.

## Deploy
Pushes to `main` that change the Worker in `relay/` (not only `relay/test/`) deploy it automatically,
after the Release gate's checks and the diagnostics deployment, once the repository has the
`CLOUDFLARE_API_TOKEN` secret described in the [diagnostics README](../diagnostics/README.md). That job
never changes secrets, KV or `wrangler.toml`. To deploy by hand or deploy your own copy, use your machine:
```sh
npm ci -w relay                                 # at the repository root: the relay's pinned Wrangler
cd relay
npx wrangler login
npx wrangler secret put DISCORD_WEBHOOK_URL      # paste the webhook URL when prompted
# optional e-mail via Resend:
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put REPORT_EMAIL_TO
npx wrangler secret put REPORT_EMAIL_FROM
# optional shared rate limiting:
npx wrangler kv namespace create RATE_LIMIT     # then add the id to wrangler.toml
npx wrangler deploy
```
`wrangler deploy` prints the Worker URL, for example
`https://nexusmods-bypass-relay.<your-subdomain>.workers.dev`. If it differs from the one in the
extension, update `RELAY_ORIGIN` in `src/lib/shared.js`. The manifest needs no relay host permission.

Then check it and build the extension with the relay switched on:
```sh
curl "$RELAY/v1/health"                     # {"ok":true,"configured":true,...}
NXTK_RELAY_CONFIGURED=1 NXTK_REQUIRE_DOM=1 node tools/build-zip.mjs
```
Until the relay is deployed, leave `RELAY_CONFIGURED = false` in `src/lib/shared.js` (or build with
`NXTK_RELAY_CONFIGURED=0`): the report page then shows **Send** as unavailable and offers a prefilled
GitHub issue (with the full JSON on the clipboard) instead of failing on click, and automatic error
reports stay off.

`GET /v1/health` answers `{ ok, configured }`; the report page calls it before every send so a failure
names its cause (not configured, unreachable, rate limited, too large, server error).

The extension requests no additional host permission for the relay. Requests use `mode: cors`
and `credentials: omit`; the Worker replies to the extension origin and the JSON preflight. Missing
or incorrect CORS headers fail delivery and leave automatic reports in the bounded retry queue.
This removes a browser access prompt, while automatic reporting still requires the user to opt in.

## Test
```sh
curl -X POST "$RELAY/v1/report" -H 'content-type: application/json' \
  -d '{"schema":1,"kind":"auto","version":"2.9.0","error":{"code":"test"}}'
```
`node tests/unit/auto-reports-test.mjs` checks opt-in, retries, aggregation, limits and revocation without network access.
`node tests/unit/report-consent-test.mjs` checks the one-time invitation, Greek copy, keyboard accessibility and explicit opt-in without an access prompt.
`node relay/test/relay-test.mjs` runs the validation, rate-limit, Discord-formatting and failure-path tests offline.
`node relay/test/discord-dispatch-test.mjs` checks embed limits, clipping, Retry-After handling and bounded retries in `discord.js`.

<img src="../docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="../docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
