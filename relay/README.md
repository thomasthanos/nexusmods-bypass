# Bug-report relay

A small Cloudflare Worker that receives reports from the extension's **Send bug report** page (and
the optional, off-by-default anonymous error reports), checks them, and forwards them to a Discord
channel (and optionally e-mail). The extension never contains the webhook or any other secret.

## What it does
- `POST /v1/report`, JSON only, at most 64 KB, schema version 1 (see `validateReport` in `worker.js`).
- At most 10 reports per IP per hour. With a KV namespace bound as `RATE_LIMIT` the counters are
  shared across Cloudflare's edge. Without one, a per-isolate in-memory limiter only slows down bursts.
  For a hard limit, add a Cloudflare Rate Limiting rule on the route. No Durable Object is needed.
- Posts a Discord embed with mentions disabled. If Resend is configured, it also e-mails the full JSON.
- CORS only for extension origins (`ALLOWED_ORIGINS`).

## Deploy
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
extension, update **both**:
- `RELAY_ORIGIN` in `src/shared.js`
- `optional_host_permissions` in `src/manifest.json`

The relay origin is an *optional* host permission: users are asked for it the first time they press
**Send report**, so updating the extension never shows a new permission warning.

## Test
```sh
curl -X POST "$RELAY/v1/report" -H 'content-type: application/json' \
  -d '{"schema":1,"kind":"auto","version":"2.9.0","error":{"code":"test"}}'
```
`node tools/relay-test.cjs` runs the validation, rate-limit and Discord-formatting tests offline.
