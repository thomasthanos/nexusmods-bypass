<p align="center">
  <img src="docs/assets/header-privacy.svg" alt="Privacy policy - NexusMods Bypass" width="100%" />
</p>

<p align="center"><sub><a href="README.md">← README</a> · <a href="PRIVACY.md">Privacy</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="CHANGELOG.md">Changelog</a></sub></p>

<img src="docs/assets/divider.svg" alt="" width="100%" />


**Last updated:** 14 October 2026
**Publisher:** Thomas Thanos

NexusMods Bypass has no analytics SDK, advertising SDK, tracking pixel, account system, or background analytics. Optional technical error reporting is described below. The published extension source is not minified or obfuscated, so these claims can be audited.

## Data stored on your device

- Settings such as download flow, pacing, download folder, and language override.
- Local download history used to skip files that already completed and to resume interrupted runs.
- A rolling log of the latest extension errors, used only to prepare readable bug reports.

A short list of the last few actions the extension took is also kept, so that a bug report can show
what led up to a fault. That list is held in memory only, is capped at eight short entries, and is
gone as soon as the page is closed or reloaded. It is never written to storage.

All of this data is stored in local browser extension storage.

## Network activity

The extension makes only the Nexus Mods requests needed to resolve and start downloads - the same requests the browser would make when the corresponding buttons are clicked manually. Collection, mod and file details are read from Nexus Mods' documented API (`api.nexusmods.com`) with your existing Nexus session, the same way the site does; no API key is stored. Endorse and Track are sent only when you click those buttons. "Identify archives by hash" hashes your files locally and sends only the MD5 to Nexus. It does not transmit extension data to the publisher or to an analytics service, except manual reports you choose to send and technical errors after you enable automatic reporting (below).

## Cookies

While **Hide ads and Premium panels** is on, the extension writes one first-party Nexus Mods cookie, `ab`, which is the timer Nexus uses to decide whether a download's ad countdown has elapsed. It is written on nexusmods.com only, expires by itself after five minutes, is never read back, and is never sent anywhere other than Nexus Mods. Because it expires inside five minutes and a collection run takes longer, an open collection tab rewrites it at most once a minute for as long as that run lasts; the value written is the same each time. Turning that setting off stops it being written. The extension reads no other cookies and does not request the browser's cookies permission.

## Bug reports

The **Report a bug** action opens a GitHub issue form with recent errors, and the last few actions the extension took, included in the draft. The **Add details** button on an error opens the report page for that specific incident, with a stable error reference that also appears in Discord. The **Send bug report** page shows the exact JSON that would be sent - version, browser, a settings snapshot (the download folder only as "custom"/"default"), recent errors and, only if you tick it, the local debug log - and you can copy it, open a GitHub issue, or send it. Everything is redacted first: usernames, emails, cookies, tokens, file paths and URL query strings are removed.

Sending goes to the maintainer's report relay (`nexusmods-bypass-relay.mariosthanos3.workers.dev`), a Cloudflare Worker that forwards the report to a private Discord channel (and optionally email). Reports use standard CORS requests allowed by the relay. No additional host permission is declared or requested. Clicking Enable in the Nexus page invitation saves your reporting choice directly, without opening another page. Choosing No thanks, dismissing with Escape, or leaving it alone keeps reporting off. The invitation has labelled controls, screen-reader announcements and keyboard support. The relay keeps no copy of the report itself. It stores only separate per-IP rate-limit counters for manual and automatic reports (until the end of the hour) and, for automatic error reports, a fingerprint of the version and error reference (one hour, or six hours for network errors) plus a marker that limits maintainer notifications to one a day, so duplicate deliveries are not forwarded repeatedly. If a report cannot be delivered, the relay writes a one-line technical note to its Cloudflare log: the report's id, type, error code, extension version and the HTTP status, never the report text or your IP address. The relay receives your IP address for rate limiting; it is not forwarded to Discord. Technical reporting is not a guarantee of anonymity.

**Automatic error reports** remain off by default. After an extension update, a dismissible invitation appears once across your Nexus Mods tabs, on the first visible page loaded with the updated extension. It does not enable anything. Choosing No thanks or closing it leaves reports off; future updates do not repeat the invitation. Users who already enabled reporting are not asked again. You can also enable or disable reporting from the report page.

After you explicitly enable reporting, new extension faults send a small technical record: extension version, browser name and major version, stable error reference, error code and HTTP status, redacted technical cause and action, packaged script position, page **type** (collection/mod/Nexus/extension), occurrence count and first/last observation times. No complete page URL, page content, download history, settings snapshot, account details or full stack trace is included. Ordinary conditions such as being offline, needing to sign in, cancelling a download or Nexus rate limiting stay local. Background faults and confirmed collection-download failures use the same reporting path.

Distinct faults can send immediately. Repetitions are grouped per fault and sent no sooner than ten minutes after its last confirmed report. Delivery is limited to ten confirmed reports and thirty delivery attempts per UTC day. Pending diagnostics are kept locally, with a maximum of twenty distinct faults and a lifetime of 24 hours. Failed sends retry with a 15-second request timeout and increasing delays, up to six attempts; rate limiting honours Retry-After. Invalid reports are discarded. Disabling reporting aborts the current request where possible and clears the local pending queue. Reports already delivered cannot be withdrawn by disabling the setting.

## Downloads permission

The `downloads` permission starts browser downloads and places files in the configured subfolder. It does not read the user's existing download history.

The `downloads.ui` permission (Chrome and Edge only; Firefox builds omit it) lets the extension hide the browser download bubble while a collection download is running and turn it back on when the run finishes, stops or fails. It grants no access to download data.

## Scripting permission

The `scripting` permission lets the extension add parts of its own packaged code — the collection downloader, the settings dialog, the bug report builder and the Wabbajack importer — to a Nexus Mods page the first time that page needs them, instead of loading them into every page. It is used only on nexusmods.com and only with files inside the extension package. It gives the extension no access it did not already have there, and nothing is fetched from anywhere else.

## Your controls

**Restore Defaults** clears the saved configuration. Removing the extension removes its locally stored data.

Third-party requests to Nexus Mods remain subject to Nexus Mods' own terms and privacy policy. NexusMods Bypass is not affiliated with, endorsed by, or connected to Nexus Mods.

Material changes to this policy will be reflected in its update date and in the public commit history.

<img src="docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
