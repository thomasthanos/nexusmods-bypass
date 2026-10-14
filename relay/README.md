<p align="center">
  <img src="../docs/assets/header-relay.svg" alt="Bug-report relay" width="100%" />
</p>

<p align="center"><sub><a href="../README.md">← README</a> · <a href="../PRIVACY.md">Privacy</a> · <a href="../CONTRIBUTING.md">Contributing</a> · <a href="../CHANGELOG.md">Changelog</a></sub></p>

<img src="../docs/assets/divider.svg" alt="" width="100%" />


A small Cloudflare Worker that receives reports from the extension's **Send bug report** page (and
the optional, off-by-default technical error reports), checks them, and forwards them to a Discord
channel (and optionally e-mail). The extension never contains the webhook or any other secret.

## Current deployment

Updated on 2026-10-13 at https://nexusmods-bypass-relay.mariosthanos3.workers.dev with compact auto-error embeds.
The Discord destination is stored as the Cloudflare Worker secret `DISCORD_WEBHOOK_URL`.
The live health check returned `ok: true, configured: true`. Initial Discord delivery was verified
on 2026-10-12; no Discord test message was sent for the compact-embed update.
`RELAY_CONFIGURED` is enabled in the extension. The deployed Worker already allows extension
origins through CORS. The 3.1.1 extension uses those ordinary CORS requests without asking for a relay
host permission; earlier releases request the optional permission. KV-backed rate limiting and auto-report dedupe use the `RATE_LIMIT` binding in
`wrangler.toml`. KV is eventually consistent: this shares counters across instances but does not
provide a strict atomic limit. E-mail is not configured.

## Pending update in this branch

The 3.1.1 extension uses a durable opt-in queue and remains compatible with the currently deployed schema-1 relay. Deploy this branch's Worker to show the new error reference, occurrence count, observation times, redacted technical cause and packaged script position in Discord, and to separate the manual and automatic rate-limit allowances. The changes below have been tested offline; they have **not** been deployed by this change. No live Discord test message is sent by the test suites.

## What it does
- `POST /v1/report`, JSON only, at most 64 KB, schema version 1 (see `validateReport` in `worker.js`).
- At most 10 reports **of each kind** per IP per hour, so automatic reports cannot exhaust the manual allowance. With a KV namespace bound as `RATE_LIMIT` the counters are
  shared across Cloudflare's edge. Without one, a per-isolate in-memory limiter only slows down bursts.
  For a hard limit, add a Cloudflare Rate Limiting rule on the route. No Durable Object is needed.
- Posts one compact Discord embed for automatic errors, with a plain-language explanation,
  page type/action context, a short browser name, an error reference shared with manual reports, occurrence count, observation times, technical cause and packaged script position. Automatic errors have no JSON attachment.
- Manual bug reports still include the full JSON file, preserving the description, reproduction
  steps, expected result and reviewed diagnostics. Mentions are disabled for both report types.
  If Resend is configured, it also e-mails the full JSON.
- CORS only for extension origins (`ALLOWED_ORIGINS`).

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
