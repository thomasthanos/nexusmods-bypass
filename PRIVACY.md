<p align="center">
  <img src="docs/assets/header-privacy.svg" alt="Privacy policy - NexusMods Bypass" width="100%" />
</p>

<p align="center">
  <a href="README.md"><img src="docs/assets/link-readme.svg" alt="Back to the README" height="42" /></a>
  <a href="PRIVACY.md"><img src="docs/assets/link-privacy.svg" alt="Privacy" height="42" /></a>
  <a href="CONTRIBUTING.md"><img src="docs/assets/link-contributing.svg" alt="Contributing" height="42" /></a>
  <a href="CHANGELOG.md"><img src="docs/assets/link-changelog.svg" alt="Changelog" height="42" /></a>
  <a href="LICENSE"><img src="docs/assets/link-license.svg" alt="Licence" height="42" /></a>
</p>

<img src="docs/assets/divider.svg" alt="" width="100%" />


**Last updated:** 13 September 2026
**Publisher:** Thomas Thanos

NexusMods Bypass has no analytics SDK, advertising SDK, tracking pixel, telemetry, account system, or remote data service. The published extension source is not minified or obfuscated, so these claims can be audited.

## Data stored on your device

- Settings such as download flow, pacing, download folder, and language override.
- Local download history used to skip files that already completed and to resume interrupted runs.
- A rolling log of the latest extension errors, used only to prepare readable bug reports.

A short list of the last few actions the extension took is also kept, so that a bug report can show
what led up to a fault. That list is held in memory only, is capped at eight short entries, and is
gone as soon as the page is closed or reloaded. It is never written to storage.

All of this data is stored in local browser extension storage.

## Network activity

The extension makes only the Nexus Mods requests needed to resolve and start downloads - the same requests the browser would make when the corresponding buttons are clicked manually. Collection, mod and file details are read from Nexus Mods' documented API (`api.nexusmods.com`) with your existing Nexus session, the same way the site does; no API key is stored. Endorse and Track are sent only when you click those buttons. "Identify archives by hash" hashes your files locally and sends only the MD5 to Nexus. It does not transmit extension data to the publisher or to an analytics service, except a bug report you choose to send (below).

## Cookies

While **Hide ads and Premium panels** is on, the extension writes one first-party Nexus Mods cookie, `ab`, which is the timer Nexus uses to decide whether a download's ad countdown has elapsed. It is written on nexusmods.com only, expires by itself after five minutes, is never read back, and is never sent anywhere other than Nexus Mods. Because it expires inside five minutes and a collection run takes longer, an open collection tab rewrites it at most once a minute for as long as that run lasts; the value written is the same each time. Turning that setting off stops it being written. The extension reads no other cookies and does not request the browser's cookies permission.

## Bug reports

The **Report a bug** action opens a GitHub issue form with recent errors, and the last few actions the extension took, included in the draft. The **Send bug report** page shows the exact JSON that would be sent - version, browser, a settings snapshot (the download folder only as "custom"/"default"), recent errors and, only if you tick it, the local debug log - and you can copy it, open a GitHub issue, or send it. Everything is redacted first: usernames, emails, cookies, tokens, file paths and URL query strings are removed.

Sending goes to the maintainer's report relay (`nexusmods-bypass-relay.mariosthanos3.workers.dev`), a Cloudflare Worker that forwards the report to a private Discord channel (and optionally email). The browser asks for that site as an optional permission the first time you send; it is never requested otherwise. The relay keeps no copy of the report itself. It stores only a per-IP rate-limit counter (about an hour) and, for automatic error reports, a fingerprint of the version, error code, status and short context (10 minutes) so the same error is forwarded once.

**Automatic error reports** are off by default. When turned on (on the report page, which also asks for the same optional permission), new errors are sent as a minimal anonymous record - version, browser and the redacted error - at most once per 10 minutes and 10 per day. Revoking the permission or turning the setting off stops them.

## Downloads permission

The `downloads` permission starts browser downloads and places files in the configured subfolder. It does not read the user's existing download history.

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
