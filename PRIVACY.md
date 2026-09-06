# Privacy policy - NexusMods Bypass

**Last updated:** 6 September 2026
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

The extension makes only the Nexus Mods requests needed to resolve and start downloads - the same requests the browser would make when the corresponding buttons are clicked manually. It does not transmit extension data to the publisher or to an analytics service.

## Cookies

While **Hide ads and Premium panels** is on, the extension writes one first-party Nexus Mods cookie, `ab`, which is the timer Nexus uses to decide whether a download's ad countdown has elapsed. It is written on nexusmods.com only, expires by itself after five minutes, is never read back, and is never sent anywhere other than Nexus Mods. Because it expires inside five minutes and a collection run takes longer, an open collection tab rewrites it at most once a minute for as long as that run lasts; the value written is the same each time. Turning that setting off stops it being written. The extension reads no other cookies and does not request the browser's cookies permission.

## Bug reports

The **Report a bug** action opens a GitHub issue form with recent errors, and the last few actions the extension took, included in the draft. Both are redacted for query strings and parameters that could carry a session or an identifier before they reach the draft. The user can review and edit the draft before choosing whether to submit it. Nothing is submitted automatically.

## Downloads permission

The `downloads` permission starts browser downloads and places files in the configured subfolder. It does not read the user's existing download history.

## Your controls

**Restore Defaults** clears the saved configuration. Removing the extension removes its locally stored data.

Third-party requests to Nexus Mods remain subject to Nexus Mods' own terms and privacy policy. NexusMods Bypass is not affiliated with, endorsed by, or connected to Nexus Mods.

Material changes to this policy will be reflected in its update date and in the public commit history.
