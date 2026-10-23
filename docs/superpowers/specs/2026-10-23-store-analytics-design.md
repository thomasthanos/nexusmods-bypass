# Store activity in the private diagnostics dashboard

The owner wants the eight GA4/Chrome Web Store metrics and new-review notifications in the existing phone Overview. Continue directly on main and preserve the current neumorphic interface, private Access boundary, existing report consent and notification registrations.

GA4 property 547084285 belongs to Google's managed Chrome Web Store developer account. It measures listing visitors, not extension runtime activity. The owner has a fixed Marketer role and cannot invite a service account. Connect the existing Google user with a dedicated read-only OAuth client; keep refresh credentials only in an encrypted Worker secret. Use a local one-time callback helper for authorization rather than a browser token or a new telemetry integration.

Show last-30-minute listing active users, active users for the last seven complete property-zone days and their previous-period change, and unique listing visitors since property creation. Never add daily unique counts. Expose source, period, timezone, quality limitations and unavailable/stale states. Do not invent zero values when Google is disconnected or failing.

Store metrics come from the fixed public extension ID chfghiknjhpcncpcjopglefnckckdlpj. Distinguish the public users badge from cumulative installs, and rating count from written-review count. Compare store version with the latest public GitHub release. The public Store read interface is undocumented: validate its data shape, bound responses and requests, and retain a clearly marked last successful snapshot on failure.

Poll public Store data every fifteen minutes. The first complete sync establishes a baseline without sending old reviews as new. Later new stable review IDs create text-only dashboard cards and durable per-subscription notification work. Edits do not become new reviews. Prevent overlapping syncs and deliveries with database leases and immutable delivery receipts; retry transient failures with bounded backoff. No exact-once provider delivery promise is possible after a process crash between provider acceptance and persistence; stable notification tags reduce device duplicates.

All private routes require existing Access verification; mutations retain same-origin checks. Never expose tokens, private keys, raw provider errors, arbitrary external links or reviewer avatars. Review notifications open only a validated same-origin review route. No extension permissions, runtime tracking or reporting defaults change.

Validation covers source parsers, provider failures, GA4 response semantics, real SQLite migrations/leases/review replay, push URL validation, mobile widths, hostile review text, reduced motion, stale auth and polling cleanup. Verify the deployment, consent-dependent Google connection, main push and CI honestly.
