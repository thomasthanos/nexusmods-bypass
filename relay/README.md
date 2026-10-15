<p align="center">
  <img src="../docs/assets/header-relay.svg" alt="Bug-report relay" width="100%" />
</p>

<p align="center"><sub><a href="../README.md">← README</a> · <a href="../PRIVACY.md">Privacy</a> · <a href="../CONTRIBUTING.md">Contributing</a> · <a href="../CHANGELOG.md">Changelog</a></sub></p>

<img src="../docs/assets/divider.svg" alt="" width="100%" />


A small Cloudflare Worker that receives reports from the extension's **Send bug report** page (and
the optional, off-by-default technical error reports), checks them, and forwards them to a Discord
channel (and optionally e-mail). The extension never contains the webhook or any other secret.

## Current deployment

Updated on 2026-10-14 at https://nexusmods-bypass-relay.mariosthanos3.workers.dev.
The latest notification update distinguishes red user reports from GitHub automation and configures
one explicit maintainer mention. Its formatting and mention policy were verified offline; no new
test message or ping was sent for this update.
The Discord destination is stored as the Cloudflare Worker secret `DISCORD_WEBHOOK_URL`.
The live health check returned `ok: true, configured: true` (HTTP 200); JSON preflight returned 204.
Real Edge and Firefox extension-origin requests passed, including CORS error responses and without
additional relay host permissions. During the earlier 3.1.1 deployment validation, one clearly marked synthetic Discord report was accepted (HTTP 200,
report `e0e83e8f`, reference `E-0880e90`); `wait=true` confirms Discord delivery before the relay returns success.
Manual JSON attachments, limits, duplicate suppression and opt-out behavior were also checked offline.
`RELAY_CONFIGURED` is enabled in the extension. The deployed Worker already allows extension
origins through CORS. The 3.1.1 extension uses those ordinary CORS requests without asking for a relay
host permission; earlier releases request the optional permission. KV-backed rate limiting and auto-report dedupe use the `RATE_LIMIT` binding in
`wrangler.toml`. KV is eventually consistent: this shares counters across instances but does not
provide a strict atomic limit. E-mail is not configured.

## Deployed 3.1.1 reporting update

The 3.1.1 extension uses a durable opt-in queue with the deployed schema-1 relay. Discord automatic-error embeds include the shared error reference, occurrence count, observation times, redacted technical cause and packaged script position. Manual and automatic reports have separate rate-limit allowances. User preferences were not changed; declining the invitation keeps automatic reports off. The test suites use mocked destinations and send no live Discord messages.

The previously reported HTTP 403 / Cloudflare code 1010 did not reproduce in the live browser checks. No Cloudflare security settings were weakened, and the historical incident is not claimed as fixed.

## Prepared 3.1.2 update (separate deployment required)

This branch changes the Worker; it does not describe a completed production deployment.
Automatic reports use the title `Automatic report`, while manual reports retain `Bug report`.
The red user-report branding and configured maintainer are retained. The same fault/version is
forwarded at most hourly, or every six hours for network/timeout errors. An automatic fault/version
can mention the maintainer once in 24 hours; manual reports retain their explicit notification.
Both windows live in the existing `RATE_LIMIT` KV binding, with per-isolate memory as a fallback.
Counters are occurrences in the forwarded client report, not unique users or global totals.
Optional `error.causeCode` is backwards compatible with schema 1 and lets security-blocked files be
labelled explicitly. Older clients' blocked-file messages are also recognised. No browser or
antivirus block is bypassed. Test destinations are mocked; no live Discord message is sent.

For an existing deployment, authenticate with Cloudflare and run `npx wrangler deploy` from `relay/`.
Keep the existing `DISCORD_WEBHOOK_URL`, `REPORT_MENTION_USER_ID`, CORS origins and `RATE_LIMIT` binding.
Do not rotate or overwrite the existing destination secret just to update the Worker.

## What the updated Worker does
- `POST /v1/report`, JSON only, at most 64 KB, schema version 1 (see `validateReport` in `worker.js`).
- At most 10 reports **of each kind** per IP per hour, so automatic reports cannot exhaust the manual allowance. With a KV namespace bound as `RATE_LIMIT` the counters are
  shared across Cloudflare's edge. Without one, a per-isolate in-memory limiter only slows down bursts.
  For a hard limit, add a Cloudflare Rate Limiting rule on the route. No Durable Object is needed.
- Posts one compact Discord embed for automatic errors, with a plain-language explanation,
  page type/action context, a short browser name, an error reference shared with manual reports, occurrence count, observation times, technical cause and packaged script position. Automatic errors have no JSON attachment.
- User reports have a red accent and a distinct `Automatic report` / `Bug report` title and sender name.
  `REPORT_MENTION_USER_ID` in `wrangler.toml` allows one explicit maintainer mention; it is a public
  Discord user ID, not a secret. Report input cannot choose recipients, mention roles or ping everyone.
- Manual bug reports still include the full JSON file, preserving the description, reproduction
  steps, expected result and reviewed diagnostics. Mentions from report text are disabled for both report types;
  only the configured maintainer may be pinged.
  If Resend is configured, it also e-mails the full JSON.
- CORS only for extension origins (`ALLOWED_ORIGINS`).

GitHub automation is separate: its sender is `NexusMods Bypass · GitHub`, titles start with `GitHub`,
repository changes/issues are blue, releases green and permission/schema warnings amber. It does not
ping the report recipient. Manifest summaries use Discord-friendly bullets; missing/invalid Firefox
manifests are reported as unavailable, never as an unchanged `? → ?` comparison.

## Deploy
To update this deployment or deploy your own copy, use your machine. The relay is **not deployed by CI**:
`wrangler` needs an interactive `wrangler login` (or a
Cloudflare API token, which this repository deliberately does not hold). Deploy from your machine:
```sh
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
extension, update `RELAY_ORIGIN` in `src/shared.js`. The manifest needs no relay host permission.

Then check it and build the extension with the relay switched on:
```sh
curl "$RELAY/v1/health"                     # {"ok":true,"configured":true,...}
NXTK_RELAY_CONFIGURED=1 NXTK_REQUIRE_DOM=1 node tools/build-zip.mjs
```
Until the relay is deployed, leave `RELAY_CONFIGURED = false` in `src/shared.js` (or build with
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
`node tools/auto-reports-test.cjs` checks opt-in, retries, aggregation, limits and revocation without network access.
`node tools/report-consent-test.cjs` checks the one-time invitation, Greek copy, keyboard accessibility and explicit opt-in without an access prompt.
`node tools/relay-test.mjs` runs the validation, rate-limit and Discord-formatting tests offline.

<img src="../docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="../docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
