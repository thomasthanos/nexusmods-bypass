<p align="center">
  <img src="docs/assets/header-changelog.svg" alt="Changelog" width="100%" />
</p>

<p align="center">
  <a href="README.md"><kbd> ← README </kbd></a>&ensp;·&ensp;
  <a href="PRIVACY.md"><kbd> 🔒 Privacy </kbd></a>&ensp;·&ensp;
  <a href="CONTRIBUTING.md"><kbd> 🤝 Contributing </kbd></a>&ensp;·&ensp;
  <kbd><b> 📋 Changelog </b></kbd>
</p>

<img src="docs/assets/divider.svg" alt="" width="100%" />

Release notes and historical commits for NexusMods Bypass. Recent releases are listed first; older
commits remain grouped by date with links to the corresponding changes. Pre-split history
(before 2026-08-24) is preserved below.

<p align="center">
  <a href="https://github.com/thomasthanos/nexusmods-bypass/releases/latest"><kbd> Latest release ↗ </kbd></a>&ensp;·&ensp;
  <a href="#release-3-3-1"><kbd> 3.3.1 </kbd></a>&ensp;·&ensp;
  <a href="#release-3-3-0"><kbd> 3.3.0 </kbd></a>&ensp;·&ensp;
  <a href="#release-3-2-0"><kbd> 3.2.0 </kbd></a>&ensp;·&ensp;
  <a href="https://github.com/thomasthanos/nexusmods-bypass/releases"><kbd> All releases ↗ </kbd></a>
</p>

<a id="unreleased"></a>

## Unreleased

- **iPhone diagnostics issues:** the Issues screen also lists open public GitHub issues and recent Discussions, separately from opted-in diagnostic reports. Each source loads independently and uses fixed repository links with text-only content. Default date ranges advance when the app resumes after UTC midnight so recent reports remain visible. The complete mobile browser suite now runs in WebKit as well as Chromium.
- **iPhone diagnostics: GitHub issues and Discussions load.** The Worker asked GitHub with the `error` redirect mode, which the Workers runtime rejects before sending, so both lists always showed as temporarily unavailable; the tests ran in Node, which accepts it. Both requests now use `manual`, and a new test runs both feeds in workerd, the Workers runtime itself. A feed of about twenty discussions also exceeded the XML parser's 10,000-expansion cap, because GitHub sends each body as escaped HTML; references are now bounded by the 2 MiB body limit. Behind Cloudflare Access the Cache API stores nothing, so the last good list is kept in the Worker's memory for the five-minute refresh and the marked stale fallback. An optional `GITHUB_TOKEN` secret gives the issue list its own GitHub rate limit; once the token expires, reads continue anonymously. On small screens the GitHub links sit in their card headings. The diagnostics Worker must be redeployed for these to take effect.
- **Automatic report durability:** transient extension-storage read failures no longer discard pending automatic reports or masquerade as reporting opt-out.
- **Development dependency security:** the Firefox package check now calls Mozilla's `addons-linter` directly, preserving the existing validation settings and removing an unused Android runner dependency that pulled in vulnerable `node-forge`.
- **Browser download folder (<a href="https://github.com/thomasthanos/nexusmods-bypass/issues/34"><kbd>#34</kbd></a>):** with the folder left empty, the browser places each file as it places its own downloads, so *Ask where to save each file* opens the folder chosen last. On Opera, files meant for `D:\mods` landed in `C:\Users\…\Downloads`: a file the extension names always goes to the browser's download location. A folder name, a link without a usable file name and *Write Mod Organizer 2 .meta files* still save there.
- **A full path is not a folder name:** `D:\mods` typed as the folder became `Downloads\D mods`. It is no longer saved; the settings and the setup page say to choose it as the browser's download location instead, in all 13 languages.

<a id="release-3-3-1"></a>

## 3.3.1 — 2026-10-23

- **Safari notification setup:** protected POST requests now retain their real origin under the dashboard's `no-referrer` policy. WebKit previously sent `Origin: null`, so registering or testing notifications returned `403` and incorrectly cleared the dashboard as if the Access session had expired. A blocked operation now keeps the session available; real authentication failures still clear private data.
- **Mobile diagnostics UI:** bounded date/select fields, clearer filter grids, full-width actions and safe-area-aware bottom navigation improve the dashboard on small screens. Returning to the app refreshes the current view; cancelled requests cannot invalidate a newer session, and an authenticated session check provides recovery without bypassing Access.
- **Private diagnostics integration:** a separate **Private diagnostics dashboard** opt-in (`PrivateDiagnostics`, off by default and requiring automatic reports) sends future redacted faults through the existing relay to the private service. A random installation seed's SHA-256 hash and browser/OS information support grouping. Extra debug lines still require extra diagnostics. Existing reporting users keep their current choice; no heartbeat/attempt telemetry or historical Discord import is enabled.
- **Private diagnostics deployed:** the independent maintainer service runs on Cloudflare with a custom HTTPS domain, an EU D1 database and owner-only Access login with MFA. Deployment configuration and mobile PWA installation guidance are documented in the <a href="https://github.com/thomasthanos/nexusmods-bypass/blob/main/diagnostics/README.md"><kbd>diagnostics README</kbd></a>.
- **Discussions:** Ideas and Q&A forms have clearer prompts, topic choices and submission checklists; General Discussion and Show and Tell have dedicated forms.
- **Documentation and repository:** refreshed contribution and security guidance, compact documentation links, navigable release history, responsive badges and SVG assets, and a new project social preview.
- **Development dependencies:** upgraded `web-ext` and updated its dependency tree, including `adm-zip`, `tmp` and `shell-quote`; the older transitive `uuid` dependency is removed.
- **Relay bridge:** exact diagnostics and heartbeat paths use a fixed `DIAGNOSTICS` Worker service binding; the legacy reporting endpoint stays available. Both Workers must be updated separately from GitHub package publication. The relay baseline is 3.3.1.
- **Same-version refresh:** deliberate publication replaces both validated 3.3.1 ZIPs, notes and source tag in the existing release without posting its Discord announcement again. Existing installations need the refreshed ZIP. Download behavior and manifest permissions are unchanged.

<a id="release-3-3-0"></a>

## 3.3.0 — 2026-10-22

- **Ideas and questions in GitHub Discussions:** in the popup's **Report on GitHub** menu, *Idea or suggestion* and *Question* start a new discussion in *Ideas* or *Q&A* instead of an issue; a bug report is still an issue with the diagnostic report. The in-page settings have a **Suggest an idea** link beside **Report a bug**, in all 13 languages.
- **Repository:** the feature request and question issue forms became discussion forms, the issue chooser links to them, and a new discussion is announced on Discord like a new issue.
- **Private diagnostics source:** the independent `diagnostics/` package contains the Cloudflare Hono API, D1 schema and mobile PWA dashboard. Reports are validated, sanitized and grouped by fingerprint; rules identify site changes and regressions, and eligible events can reach Discord and Web Push. The Access-protected dashboard includes issue workflow, release-health comparisons, report timelines, copyable AI debug context and push-device management.
- **Diagnostics setup:** the new service has not been deployed or connected to the extension. It requires a separately configured domain, Cloudflare Access application, D1 database, secrets and deployment. Existing extension reporting continues through `relay/`; heartbeat telemetry requires separate client integration and consent.
- **Relay baseline:** 3.3.0, so 3.2.0 and older clients no longer ping once the existing relay Worker is separately redeployed.
- **Packages:** Chrome/Edge and Firefox use 3.3.0 with unchanged permissions and opt-in reporting behavior.

<a id="release-3-2-0"></a>

## 3.2.0 — 2026-10-21

- **Archived files (<a href="https://github.com/thomasthanos/nexusmods-bypass/issues/33"><kbd>#33</kbd></a>):** every file in a mod's file archive gets its own *Mod manager download* and *Manual download* buttons; only the top one did, because each file's box was looked for in the whole list. A file Nexus draws after the page has loaded gets its buttons too, and a file Nexus holds back or its virus scan flagged keeps what Nexus shows.
- **Mod Organizer 2 `.meta` files for single mods:** *Write Mod Organizer 2 .meta files* now also covers a file downloaded from a mod page in the browser, not only collection files, so MO2 shows the mod's description and its Nexus link opens the mod's page. The setting moves from **Collections** to **Downloads**, the `.meta` also names the mod (`modName`), and games go by MO2's own names (`newvegas` is `FalloutNV`, `enderalspecialedition` is `EnderalSE`).
- **Relay baseline:** 3.2.0, so 3.1.9 and older clients no longer ping once the Worker is redeployed.
- **Packages:** Chrome/Edge and Firefox use 3.2.0 with unchanged permissions.

<a id="release-3-1-9"></a>

## 3.1.9 — 2026-10-20

- **Vortex downloads that ended as a lost connection (<a href="https://github.com/thomasthanos/nexusmods-bypass/issues/30"><kbd>#30</kbd></a>):** a *Mod Manager Download* whose `/api/files/<uid>/download` route a fetch cannot read, while Nexus answers the other requests, is opened the way the click itself opens it, and the browser takes it to Vortex. A definitive answer from Nexus (sign-in, access denied, file not found, rate limit, Cloudflare check) is shown as it is and never opened (<a href="https://github.com/thomasthanos/nexusmods-bypass/pull/32"><kbd>#32</kbd></a>). A collection run fails such a file at once instead of waiting about 17 minutes for a connection that works.
- **Fewer false reports:** Cloudflare and bare error pages at a mod's address, and Nexus notices in place of the download control, are no longer reported as site changes. A collection's Vortex run reports how each file ended, not every attempt, and a request Firefox cancels as the page navigates is not reported. A "no link" report names the kind of link or notice Nexus answered with, and whether the ad-timer cookie was off.
- **Collection file names:** collection files get the same name as single-mod downloads: the name in the download link, otherwise `<mod name>-<file id>`.
- **Mod Organizer 2 `.meta` files:** new setting *Write Mod Organizer 2 .meta files* (`WriteMo2Meta`, off by default, under Collections, in all 13 languages). After a collection file is saved in the browser, a `.meta` file with its Nexus mod id, file id and version is saved beside it.
- **Busy download buttons:** *Download all mods* (and the mandatory and optional ones) show a spinner and stay disabled until the progress deck opens or the start is refused.
- **Saved data survives a failed read:** a storage read that feeds a write fails instead of returning the empty default, so it can no longer overwrite settings, history, queue jobs or claims.
- **Relay:** besides 10 reports per IP an hour, the relay refuses reports once all clients together reach 500 an hour, and the tests check that its baseline matches the manifest version. This needs `npx wrangler deploy` from `relay/`.
- **Releases:** the live Nexus schema check no longer blocks a release; the weekly schema watch still reports problems.
- **Relay baseline:** 3.1.9, so 3.1.8 and older clients no longer ping once the Worker is redeployed.
- **Packages:** Chrome/Edge and Firefox use 3.1.9 with unchanged permissions.
- The collection file names, `.meta` files, busy buttons, storage reads, relay limit and release check were contributed by <a href="https://github.com/kxgcayh"><kbd>@kxgcayh</kbd></a> in <a href="https://github.com/thomasthanos/nexusmods-bypass/pull/31"><kbd>#31</kbd></a>. Thank you!

## 3.1.8 — 2026-10-18

- **Requirements in view (<a href="https://github.com/thomasthanos/nexusmods-bypass/issues/29"><kbd>#29</kbd></a>):** new setting *Open the Requirements section* (`ExpandRequirements`, off by default, under Appearance & language, in all 13 languages). Nexus's accordion keeps its state in the DOM and its toggle listens for a "tap" a scripted click does not make, so the section is opened the way Nexus opens one it marks `expand-default`; Nexus's own toggle then closes it as usual. Each section is opened once: one the user closed stays closed.
- **Dropped downloads retried:** Chrome's `downloads.cancel` does nothing to an interrupted download and still reports success, so a collection file cut off by a lost connection stayed resumable and failed as "NETWORK_FAILED [transient] cleanup_failed" instead of being retried. The queue now erases its own resumable record and retries once the record is confirmed gone; if the erase cannot be confirmed the file fails as before, so no second copy runs. Firefox's confirmed cancel leads to the retry too, and Stop retires such a download again.
- **Vortex links in collection runs:** the collection deck loads its file pages without `X-Requested-With`, as 3.1.7 did for single files; it passed the tab fragment, which has no `nxm://` link, to the link resolver as the page already loaded.
- **Report on GitHub menu:** the popup button opens a menu (WAI-ARIA menu pattern) of the bug report (with the diagnostic report), feature request and new question forms, labelled `bug`, `enhancement` and `question`.
- **Fixes:** the review ask under a finished run and in the popup wraps instead of squeezing its text to one letter per line. A Quick setup preset is saved as one settings patch, never half applied; a failed save rolls back every setting it changed that the user has not changed since.
- **Repository:** issue notices post once per issue, on the label (`bug`, `enhancement`, `question`), named by kind; a form's "opened" and "labeled" events posted every issue twice. Release titles come from the notes' `## <version> — <subtitle>` heading instead of a hard-coded one, and the publish job announces its own release on Discord, since a release published with the workflow's token starts no other workflow.
- **Relay baseline:** 3.1.8, so 3.1.7 and older clients no longer ping once the Worker is redeployed.
- **Packages:** Chrome/Edge and Firefox use 3.1.8 with unchanged permissions.

## 3.1.7 — 2026-10-18

- **The right file for Vortex and Mod Organizer 2:** Nexus's download dialog now names a file by its uid (the game id × 2³² plus the file id) and links to `/api/files/<uid>/download`. That uid was read as the file id, so the link search lost its scope, the download generator was asked for a file that does not exist, and the correct `nxm://` link was then refused as another file's. This was the most frequent report from 3.1.5 and 3.1.6 ("the nxm link names another file"). Clicks, dialogs, the API route, the collection deck and the final Vortex check now read either form.
- **Pages fetched as a click loads them:** the Vortex page, the requirements page and the API route are requested without `X-Requested-With`. With it, Nexus answers with the tab fragment, which has no `nxm://` link.
- **Leaving a page is a cancel:** a request cut off by closing or navigating the tab is no longer reported as a network fault, and a cancel is not logged. Connection failures of the mod-files list, mod details and game lookup, which the page works without, go to the debug log instead of a report.
- **Unavailable collections:** a collection that Nexus is moderating, has hidden or cannot find says so (local only, in all 13 languages) instead of "Unexpected response · Refresh the page".
- **Readable reports:** report text no longer masks every word after "mod", "file", "game" or "collection" ("Loading mod files" arrived as "Loading mod [id]"); ids, game domains and slugs are still masked. A "missing: page content region" warning now describes what the page has (layout, landmarks, custom elements, fixed test hooks, amount of text, kind of title; never text or ids), and Next.js's own 404 page is not counted as a site change. PRIVACY.md lists the new fields.
- **Fewer pings:** the relay pings the maintainer only for manual reports and for automatic errors from 3.1.7 or newer. Warnings and older clients' reports are still posted, without a ping. This needs `npx wrangler deploy` from `relay/`; until then the deployed Worker keeps accepting this release's reports and pings as it does now.
- **Packages:** Chrome/Edge and Firefox use 3.1.7 with unchanged permissions.

## 3.1.6 — 2026-10-16

- **Compact reports:** automatic errors and warnings use one short Discord embed plus an allowlisted JSON attachment with its preview hidden. Manual reports retain the JSON the user reviewed. Errors are red; page/schema and network warnings are amber.
- **Optional extra diagnostics:** a separate, off-by-default choice adds up to 20 redacted log lines of the same page type from the two minutes before the error, plus public file IDs when available. It does not start debug recording, attach page content or expand existing reporting consent. The choice is available in all 13 languages.
- **Consent and limits:** disabling basic reports also revokes extra diagnostics. Pending payloads are cleared without resetting daily quotas or duplicate-suppression history; enabling basic reporting cannot revive old extra-diagnostics consent.
- **Accurate incidents:** grouped errors retain the latest file-ID pair and use the incident time for the log window. Reports identify older clients against the relay's configured version without claiming those errors are fixed; different client versions remain separate.
- **Packages:** Chrome/Edge and Firefox use 3.1.6 with unchanged permissions. The Cloudflare relay retains its existing URL, Discord destination and RATE_LIMIT binding.

## 3.1.5 — 2026-10-16

- **Lost connections:** a collection run (browser queue or Vortex) waits on the same file when Nexus cannot be reached, with a countdown that names the connection (30 s growing to 5 min, about 17 minutes in all), and stops with one error only when every wait has run out. A short Wi-Fi drop used to fail every remaining file within seconds, each with its own dialog.
- **Downloads that are not the queue's:** Firefox numbers downloads afresh after a restart, so a saved id could name an unrelated download. The queue now keeps the link path of its own download and never counts, cancels or deletes a download that came from another link (Stop could delete an unrelated file).
- **Full disk:** a download refused with `FILE_NO_SPACE` or `FILE_ACCESS_DENIED` stops the run on that file with a clear message (local only) instead of asking Nexus for every remaining file. Download paths drop the characters Chrome refuses (control and format characters, a dot, space or tilde at either end), which failed files as "Invalid filename".
- **Vortex hand-off, checked against Vortex's own source:** a link is only handed to Vortex when it names the file that was asked for, since Vortex matches it by game, mod and file id. Silence is no longer counted as "Vortex did not open": with Vortex's *Bring to foreground* setting off, or the browser prompt allowed for good, every hand-off used to count as a failure and offer browser downloads. A hand-off from a background tab is reported as unknown instead of closing the tab. The second file of a run waits for a Vortex the first link may have started, and the "Vortex didn't open?" hint asks for the same Nexus account in Vortex and the browser.
- **Test Vortex:** a "No" no longer counts as a failed hand-off, and the dialog explains that a Vortex that is already open cannot come to the front for this test.
- **Page fixes:** the click the hint asks for is no longer swallowed as a duplicate; a failed Vortex link no longer hands the same file's Manual download to Nexus's slow flow; overlapping downloads keep their own error details and "Sent to Vortex" state; Pause holds a Vortex run after a skipped or failed file; "Retry failed" works after a stopped or blocked run; a deck that Nexus re-renders mid-run gets its Stop and Pause back; a run shows one error dialog instead of one per file.
- **Reports:** a download that ends without a link says what each Nexus request answered (status, time, shape of the answer, never its content); a bug in the extension is no longer reported as a network error; two different unhandled rejections are kept apart; report URL fields never carry secrets.
- **Packages:** Chrome and Firefox use 3.1.5 with the same permissions. Two relay titles changed (`no_nmm_link`, `popup_error`) and need `npx wrangler deploy` from `relay/`; the deployed Worker keeps working with this release until then.

## 3.1.4 — 2026-10-15

- **Relay resilience:** the Worker answers every failure with CORS headers instead of an opaque 500. KV read/write failures (daily write cap, one write per key per second) fall back to memory instead of refusing reports, and post-delivery bookkeeping can no longer trigger a duplicate Discord post. Bodies without a `Content-Length` are capped while streaming. Needs `npx wrangler deploy`.
- **Discord delivery:** one shared dispatcher (`relay/discord.js`) for the Worker and the GitHub workflows waits out 429s using Discord's `retry_after` plus jitter, retries 502/503/504 and network errors with bounded exponential backoff, and never retries a payload Discord rejected. A long upstream limit reaches the extension as `429` + `Retry-After`, so its queue pauses for that long. Embed text is clipped without splitting emoji, lone surrogates are repaired, and empty fields are dropped.
- **Severity colours:** crashes and manual bug reports are red (`#ED4245`), other automatic faults amber (`#E8B339`), releases green (`#57F287`); neutral GitHub notices stay blue.
- **Fallback log:** an undeliverable report, KV failure or e-mail failure is written to the Worker log as one secret-free JSON line; the e-mail copy remains the fallback destination when configured.
- **Error pipeline:** report sanitizing scans a bounded head of each text (100 KB without whitespace used to block for 15–28 s) and drops a token cut at the boundary. User messages in the error log are redacted and bounded too. A fault repeating in a loop reaches the worker once per two seconds and at most 20 entries a minute from one page or the worker. The report page no longer reads every 503 as "server not set up", and HTTP-date `Retry-After` values are understood.
- **Workflows:** release, issue, manifest and schema notices post with `node tools/discord-notification.mjs … --send` instead of `curl`, keeping the webhook off the command line.
- **Packages:** Chrome and Firefox use 3.1.4 with the same permissions. The relay changes need a separate `npx wrangler deploy` from `relay/`; until then the deployed 3.1.2 Worker keeps working with this release.

## 3.1.3 — 2026-10-15

- **Download UI conflicts:** Chrome's “Another extension has disabled the download UI” response when restoring the popup no longer produces a false background-error report. Our restriction is released and the other extension's preference is respected.
- **Reliable cleanup:** the restoration alarm is cleared in that case, repeated queue events do not repeat the request, and later collection runs can still hide and release the popup normally. Unexpected failures remain reportable and retryable.
- **Regression coverage:** tests cover the reported conflict at idle, after a collection and after a worker restart, plus alarm cleanup, recovery from unexpected failures and browsers without the optional UI API.
- **Packages:** Chrome and Firefox use 3.1.3. No additional permissions or Cloudflare Worker changes are required.

## 3.1.2 — 2026-10-15

- **Download recovery:** an unreadable `/api/files/` response can fall back to the existing download generator. Authentication, browser verification, access denials and rate limits still stop the attempt. Only the final failure is recorded; successful recovery does not send an error report.
- **Accurate page checks:** missing account controls mean unknown sign-in state. Rendered mod content and JSON-backed download components are recognised without the legacy `#section` / `file-id` attributes; loading pages are skipped.
- **Collection layouts:** the download panel can mount in rendered main content without Nexus's old `next-container` classes and recover after a page re-render. Mount retries and collection initialisation are distinguished from an actual missing mount point.
- **Quieter diagnostics:** repeated errors are summarised hourly, and network/timeout failures every six hours. The deployed Worker applies the same limits to older clients and mentions the maintainer once per fault/version per 24 hours; manual reports continue to notify normally.
- **Clearer causes:** failed requests identify the method, route category and response phase without sending URLs or credentials. Security-blocked files get an explicit explanation and keep browser/antivirus protection intact.
- **Deployment:** Chrome and Firefox packages use 3.1.2. The Worker was deployed separately on 2026-10-15 with the server-side cooldowns and revised Discord messages, preserving existing bindings. Source read-back, live health, extension-origin preflights and invalid-report CORS checks passed.

## 3.1.1 — 2026-10-14

- **One-click technical reports:** a one-time invitation on Nexus Mods lets users opt in directly, without an extra browser permission. No thanks, Escape or no action keeps reports off. Greek/English copy, keyboard and screen-reader support, larger controls and scrolling improve accessibility.
- **Reliable error delivery:** background and collection failures join the same persistent queue, with timeouts, retries and grouped repetitions. Distinct new faults can send immediately within daily limits; ordinary login/offline/cancellation/rate-limit conditions stay local. Opting out clears pending reports.
- **Selected-incident reports:** Add details opens the error the user selected, with a stable reference shared by the dialog and diagnostics; manual reports retain their reviewed JSON attachment.
- **Release aligned:** the latest release tag, banner and both ZIPs use 3.1.1. Both packages are rebuilt from the corrected source, including the refreshed onboarding page and custom Vortex test dialog.
- **Onboarding release gate fixed:** the five Vortex-dialog messages are defined in all 13 languages. The browser regression follows the actual dialog flow, checks Cancel and the final confirmation, and brings the setup section into view before checking its layout.
- **Relay deployed:** the Cloudflare Worker was updated on 2026-10-14 with richer Discord embeds and separate manual/automatic report allowances. Health, JSON preflight, real Edge/Firefox CORS requests and one clearly marked Discord delivery test passed. The existing destination, secret and KV binding were retained; automatic reports remain opt-in.

## 2026-10-13 — v3.1.0

### Settings polish and stability
- **Info explanations** smoothly expand and collapse, including rapid reversals. Reduced motion remains instant, and settled explanations can wrap naturally after resizing.
- **No background button flicker** — the NexusMods shortcut stays hidden while extension dialogs are open and returns when they close. Info clicks no longer restart its placement checks.
- **Stable shortcut on scroll** — overlap checks calculate the final position without temporarily resetting the visible button or measuring it halfway through a transition. Unchanged obstacles no longer restart its position, and real download controls and Nexus menus remain accessible.
- **Regression coverage** — targeted checks for opening/closing information, keyboard and reduced motion, rapid clicks, stable scrolling and menu/download-control overlap at higher zoom.

### Friendlier setup and errors (feat/ux-friendly)
- **First-run setup** — the welcome page asks three questions (Vortex or browser downloads, download folder, close the extra tab) and saves them. A **Test Vortex** button sends the harmless `nxm://premium` link and checks whether Vortex opened, asking "Did Vortex open?" when it cannot tell.
- **Settings presets** — "Quick setup" offers *Vortex user*, *Browser downloads* and *Minimal*; a mix shows as *Custom*. Technical settings (timeouts, Vortex speed/pause, official API, browser check) sit under **Advanced**. Presets never change pacing.
- **Error dialogs with actions** — *Sign in*, *Open file page*, *Retry in m:ss* (counts down on a rate limit, then *Retry now*) and *Use browser download*, chosen from the error.
- **Run summary** — a collection run ends with a card: sent, skipped (with reasons) and failed, plus *Retry failed*, *Copy list*, *Open failed pages* (up to 10) and the Nexus account the links were signed for.
- **Collection download history** — a deck menu entry shows *Sent to Vortex* / *Downloaded* / *Not downloaded yet*, with *Resend missing* and *Clear history*.
- **Vortex keeps failing** — after two hand-offs in a row with no sign of Vortex, a toast offers browser downloads and the Vortex install guide.
- **"Did Vortex open?" is remembered** — a yes (or Vortex visibly opening) is stored per browser profile; the question comes back only after a no or a failed hand-off.
- **Browser runs get the summary card too** — sent, skipped (including files already downloaded) and failed, built from the background queue's per-file events; *Retry failed* queues only the failed files.
- **Quick setup follows changes live** — changing a setting updates the highlighted preset and the "Custom" note at once.
- **Missing files** — a file page Nexus shows as "Object not found" (removed, hidden or a wrong link) gets a notice with *Open the Files tab* instead of a page-change warning; the page-check warning for a real change is a plain sentence, with the selector list kept for the report.
- **Collection menu actions** run after the menu closes, and a failure to open the mod picker or the update check shows an error instead of nothing.
- **Plain language** — settings and messages no longer say hand-off, NMM or fallback; descriptions are one plain sentence or two. All 13 languages updated.

### Fixed
- **"Vortex didn't open?" never appeared after cancelling Chrome's "Open Vortex?" prompt** — Chrome does not always fire a window `focus` event when its own dialog closes, so the blur looked permanent and counted as "opened". The watcher now also polls `document.hasFocus()` and treats a click or key press in the page as "back here"; a blur only counts as opened when focus has not come back for 20 s (or the page is hidden), so a prompt left open past 8 s and then cancelled is still "not opened". A failed hand-off also cancels the pending auto-close, so the hint and the button stay.
- **Stress and edge tests** — 2000-item queue ETA/summary/history timing, 2×2000 history entries against the storage quota, German and Russian popup and deck at 380 px, rapid double/triple clicks (one request), and a worker restart mid-run restoring the collection progress UI.
- **"Vortex hand-off:" debug lines were lost** — the debug log was batched for 2 s, so a tab that closed or left right after the hand-off dropped them. Hand-off lines and errors are now written at once, and the batch is flushed on `pagehide` / when the page is hidden.

## 2026-10-13 — v3.0.1

### Vortex hand-off (feat/vortex-handoff)
- **"Sent to Vortex" history** — Vortex hand-offs are recorded in a separate `vortexSent_<type>` list instead of as downloaded, so they are never skipped forever: the next run sends them again (logged as a re-send). Vortex itself skips files it already has, so a re-send is harmless. Redownload and a clean finish clear both lists.
- **First hand-off is confirmed** — after the first file, the run waits for the page to lose focus or go hidden (the OS opening Vortex). If that does not happen within 4 s, it asks once, "Did Vortex open?"; "No, stop" ends the run instead of sending the rest into the void. Pacing between files is unchanged.
- **Expired links are not sent** — the `expires` time of an nxm:// link is checked (with a 30 s margin) before the hand-off; an expired link is logged ("Link expired, fetching a new one") and fetched again once.
- **Account check** — the Nexus account a link is signed for (`user_id`) is named once per run, with a reminder that Vortex must be signed into the same account. When the page shows a different signed-in member id, a warning appears instead.
- **Clearer end-of-run message** — explains that sent files are kept as "sent", so running again only fetches what Vortex is missing.
- **Collection guidance** — the Vortex prompt and the run log recommend starting a whole collection in Vortex ("Download collection in Vortex") and using the extension to send the files Vortex asks for.
- **Live retest fixes**:
  - **"Sending to Vortex…" now shows on Nexus's real "Mod manager download" button.** The state text used to go into the first `<span>`, which on the real button is the icon wrapper. The label is a bare text node (sometimes inside the control's own shadow root), and a re-render put it back. The state is now written into the actual label text node, the icon is kept, and the state is re-applied if the framework re-renders. It also shows in a short `role=status` toast that reads "Sending to Vortex…", then "Sent to Vortex" for 2.5 s; a failed send removes the toast.
  - **"Did Vortex open?" no longer counts a cancelled prompt as success.** Chrome's own "Open xdg-open?" prompt blurs the page, and both of its answers hand the focus back. So only the page going hidden, or losing focus and staying unfocused for 15 s, counts as Vortex opening. A blur followed by focus coming back counts as unknown, and the question is asked once. As a result, a user who accepts the prompt may also be asked once per run.
  - **Single-file page (final live test).** A "Mod manager download" click that lands on `?file_id=…&nmm=1` runs the page's auto-start path ("Auto NMM"), which has no button. The new toast was only shown when there was a button, and the first-hand-off check only existed in the collection runner. Every Vortex hand-off now shows the "Sending to Vortex…" → "Sent to Vortex" toast. When there's no sign Vortex opened (the prompt was cancelled or nothing took focus), a single file gets a hint instead of a question: "Vortex didn't open? Check it's installed and set to handle nxm:// links". The toast, the sent state and the hint are written to the debug log. Clicks on the extension's own toasts and dialogs are no longer inspected by the download click interceptor.
  - **The settings button hides while a Nexus menu or popover covers it.** This covers the account menu with Sign out at 150 %. Open menus are found by role/state attributes, including inside open shadow roots and through `aria-expanded` + `aria-controls`. They are watched with a throttled MutationObserver and re-checked after pointerdown, click and key presses, so menus that open on pointerdown or animate in are caught.

### Fixed
- **Collection ETA** — the remaining time is now human-readable (`7d 8h`, `3h 12m`, `45m`, `30s`, units localized via `Intl`) and sane: per-file latency and large-file throughput are measured separately with a smoothed average, with the configured download speed as fallback. A 1975-file run that showed `17645:01:37` now estimates about half an hour.

### Added
- **Activity log** — `Completed` lines show the file size (`Completed: X (12.4 MB)`), and a date line appears when a run crosses midnight.
- **Hide browser download popup during collection downloads** (default on, Chrome/Edge) — uses `chrome.downloads.setUiOptions` while a run is active and restores it when the run ends, stops or fails; new `downloads.ui` permission, omitted from the Firefox build.

### Fixed (review and live testing)
- **Vortex skip on the real files tab** (second live test): Nexus's buttons sit in nested shadow roots of `<mod-file-download file='{"id":…}'>` / `<mod-download-buttons main-file=…>` / `<mod-download-modal file=…>` and carry the file as JSON, not `file-id`; the file id and the component's signed Vortex API link are now read from there.
- **Settings button vs. Nexus menus**: re-checked after every click, so an account menu (Sign out) that drops under it at 150 % makes it step aside, and it returns when the menu closes.
- **Skip requirement screens now covers Vortex**: a *Mod manager download* rendered as a plain button (no link) is handled like a link, so Nexus's requirements modal no longer opens (live: SkyUI 12604).
- **Nexus's requirements modal can be closed again**: its Close/Cancel buttons were taken as a download click; dismiss controls are now never intercepted, and the extension's overlay guard leaves Nexus dialogs (pointer and Escape) alone.
- **Faster Vortex hand-off with feedback**: the button says *Sending to Vortex…* at once, and the nxm link is asked from GenerateDownloadUrl first instead of after loading the whole file page.
- **Settings button**: smaller, icon-only below 1500 px width (label on hover/focus), moves above any page control it would cover and shrinks into the corner when there is no room (live: covered *Download all mods* at 150 %).
- **Popup Page settings** opens the panel on the active Nexus tab, or a Nexus tab with `#nxtk-settings`, which opens it on load (it used to open the bare home page).
- Popup Help buttons: invalid `font` shorthand fixed; the second button is now an honest *Report on GitHub* (it copies only an over-long report).
- Collection log: sizes come from the worker for the file it finished (wrong on an adopted run before), no ETA on an adopted run, date line in the UI language.
- Download bubble: not hidden for Vortex runs, checks coalesced (one storage pass per 0.5 s), restored after an extension update/reload.
- `nmm=0` no longer counts as Vortex; Vortex selectors and words moved to `selectors.js` (13 languages).
- Rate limit: *Backing off* is logged only when the run really waits, and Retry-After survives the resolve path.
- A Vortex run ends by saying how many files were handed off and that Vortex must confirm them.
- High zoom: fixed `min-width`s on menus and selects shrink with the viewport; menus open above the settings button.
- The retry line is translated; unused locale keys and dead popup CSS removed.

### Changed
- **Popup Help & Bugs** — one solid primary *Send bug report* button and a two-column row of *Copy error report* / *Debug log* with icons, sentence case, tooltips and focus rings; 13 locales.

## 2026-10-12

**Versions / tags:** tag `3.0.0` · **3.0.0** · **2.10.3** · **2.10.2** · tag `2.10.1` · **2.10.1** · **2.10.0** · **2.9.0** · **2.8.1** · **2.8.0**

### Added

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4d19f8c1737c7559c8731ab0d97c732410a227be"><kbd><code>4d19f8c</code></kbd></a> feat(diagnostics): severity embeds, embed limits, auto-error dedupe, page field, labelled GitHub issues
  - 5 files (+128 / −15): `tools/`, `CHANGELOG.md`, `relay/`, `src/report.js`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/53fac74aeac309416f22d992832ddceab3a7bb01"><kbd><code>53fac74</code></kbd></a> feat(ui): themed scrollbars, accessible custom selects, focus/hover states, reduced motion; report-page Playwright check
  - 5 files (+190 / −2): `src/content/`, `CHANGELOG.md`, `src/popup/`, `tests/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/9cbf697cc80d8af231ff19f0ef3f75f16d0f0d10"><kbd><code>9cbf697</code></kbd></a> feat: confirm before downloading more than 50 mods
  - 14 files (+196 / −3): `src/content/`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/8a94099c0f5c1d75a7394c3a4c10f267c346535c"><kbd><code>8a94099</code></kbd></a> P2/P3 UI: new-revision and update badges, click-only endorse/track, archive identification by MD5; locales; Playwright
  - 18 files (+1173 / −5): `src/content/`, `tests/`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/0a07f6c284233354739cdf612a4705c372a406b5"><kbd><code>0a07f6c</code></kbd></a> Add Playwright layout tests at 4 viewports x 3 zoom levels; release 2.8.1 — version → **2.8.1**
  - tests/visual/layout.spec.mjs loads the unpacked extension in Chromium against local fixtures (collection API canned) and asserts no horizontal overflow and that the FAB, settings modal, collection deck, mod picker, page-change not…
  - 11 files (+283 / −9): `tools/`, `.github/`, `.gitignore`, `CHANGELOG.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/11cbeb97774aee782a54e898f86e12313a85774f"><kbd><code>11cbeb9</code></kbd></a> Add package.json dev tooling, ESLint, jsdom fixture tests and web-ext lint in CI
  - package.json (dev-only: jsdom, eslint, web-ext) with test/lint scripts. - eslint.config.mjs focused on real mistakes; the codebase lints clean.
  - 13 files (+5068 / −3): `tools/`, `.github/`, `.gitignore`, `eslint.config.mjs`

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/b74e5f009f0d1faa5aa7545daddfcd6905f0c3ce"><kbd><code>b74e5f0</code></kbd></a> chore: prepare 3.0.0 major release with complete 47-commit history — version → **3.0.0**, tagged `3.0.0`
  - 9 files (+175 / −29): `.github/`, `internal/`, `CHANGELOG.md`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/d300b5e94b5b7bf36b6c8e7b02ca3d0846fb7749"><kbd><code>d300b5e</code></kbd></a> Debug log page: live view, level filter, search, clear, export (#18) (<a href="https://github.com/thomasthanos/nexusmods-bypass/pull/18"><kbd>#18</kbd></a>)
  - feat(debug): debug log page with live view, level filter, search, clear and export; PRIVACY relay host fix
  - fix(i18n): keep original locale file formatting (line endings) when adding debug keys
  - 25 files (+976 / −27): `src/debug-page/`, `tools/`, `src/popup/`, `CHANGELOG.md`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/6a5654f3b07a824e49bfca09a5f953b34ec70a4a"><kbd><code>6a5654f</code></kbd></a> Complete diagnostics rollout with shared page paths and relay KV
  - Use one redacted Nexus page-path helper in manual and automatic reports. Bind the deployed relay to shared KV rate-limit and dedupe storage and document the rollout.
  - 6 files (+26 / −24): `relay/`, `CHANGELOG.md`, `src/background.js`, `src/report.js`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/ea3599fbd3d676e518fcfe5b934da86104492f03"><kbd><code>ea3599f</code></kbd></a> Redesign report flow and relay payloads
  - This change upgrades the manual report UI into a responsive workspace with summary/category fields, reproduction details, validation, inline guidance, send protection, and a reviewed JSON preview.
  - On the relay side, Discord reports now include a JSON attachment alongside the summary, and the GitHub fallback preserves the human description while excluding the reply e-mail.
  - 23 files (+1964 / −117): `src/report-page/`, `relay/`, `tools/`, `CHANGELOG.md`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/ed27cb91b4cce4577765a8a831b66c4e7a3309bc"><kbd><code>ed27cb9</code></kbd></a> Enable deployed Cloudflare report relay
  - Point optional relay access at the deployed mariosthanos3 Worker and enable report sending after live health and Discord delivery verification. Document the deployment and keep package permission checks in sync.
  - 5 files (+18 / −9): `README.md`, `relay/`, `src/manifest.json`, `src/shared.js`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/cba153725c6c86b6700a42b9a70d69f9c383c64e"><kbd><code>cba1537</code></kbd></a> chore: 2.10.2 — version → **2.10.2**
  - 4 files (+32 / −4): `CHANGELOG.md`, `package-lock.json`, `package.json`, `src/manifest.json`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/287f280b6ef3e420f74e6f9f9ba428e78a17bd39"><kbd><code>287f280</code></kbd></a> chore(release): publish 2.10.1 (<a href="https://github.com/thomasthanos/nexusmods-bypass/pull/14"><kbd>#14</kbd></a>) — tagged `2.10.1`
  - Merge pull request #14: official Nexus API and reliability fixes
  - Publish the Chrome/Edge and Firefox packages after regression, lint, Chromium layout and live-schema checks.
  - 39 files (+2556 / −24): `src/content/`, `tools/`, `.github/`, `CHANGELOG.md`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/6bb627e0b8f81ed69ad862ec5f770c0b02125b34"><kbd><code>6bb627e</code></kbd></a> P1/P2: collections, revisions, game id and file list via official API with legacy fallback; batched details; update policy — version → **2.10.0**
  - 5 files (+217 / −9): `src/content/`, `src/manifest.json`, `src/shared.js`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/a9b5097eb44bdee915e472f50ffe64c6315d5ccc"><kbd><code>a9b5097</code></kbd></a> Phase 0: official Nexus API module (throttle, 429 backoff, caching), schema watch CI, tests
  - 8 files (+889 / −4): `tools/`, `.github/`, `package-lock.json`, `package.json`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/9ce3474abef41b610351ceae923d612c1c484256"><kbd><code>9ce3474</code></kbd></a> CI: manifest-watch permission diff with PR comment and Discord summary; optional Discord notify for releases and bug issues
  - 4 files (+214 / −0): `.github/`, `tools/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/b2a9d3fc91c4e995be5ffb1b751e3e905f94f4e7"><kbd><code>b2a9d3f</code></kbd></a> Opt-in report system: redaction, debug ring buffer, report page with preview, relay send
  - Extends the existing report builder (report.js) and Help tab instead of adding a parallel system: - shared.js: redactPersonalData (e-mails, home paths, Nexus profile names, cookies, bearer/JWT, long tokens) is now part of sanitize…
  - 38 files (+1684 / −21): `tools/`, `relay/`, `src/content/`, `src/report-page/`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/5e6000332425c9f271b0b254d776819168242a1f"><kbd><code>5e60003</code></kbd></a> Responsive layer for all injected UI (720p..4K, zoom 100-150%)
  - clamp()-based fluid sizing and gutters, viewport-bounded max-widths, modals capped to 100dvh with internal scrolling, wrapping headers/footers/button rows, 40px touch targets, viewport-relative list heights, narrow-viewport FAB th…
  - 3 files (+91 / −0): `src/content/`, `src/onboarding/`, `src/popup/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/5ac7d976871dde0c1ab30a7d62da0db1c2f6feca"><kbd><code>5ac7d97</code></kbd></a> Classify browser-download interrupts and retry with backoff
  - NXTK.classifyDownloadInterrupt maps chrome.downloads interrupt reasons to transient (2 retries), expired/refused link (1 retry with a fresh link), size check (1), unknown (1, as before), and disk/blocked/user (no retry).
  - 3 files (+49 / −1): `src/background.js`, `src/shared.js`, `tools/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/0ef75e2275f6481d55b041108fa9d80e7b7e05c9"><kbd><code>0ef75e2</code></kbd></a> Translate the updated pause-between-mods description into all locales
  - 12 files (+12 / −12): `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/e4b2c17747a3983b4ad67bd4738ad48a1b9b4e7d"><kbd><code>e4b2c17</code></kbd></a> Translate the page-change notice strings into all 13 locales
  - 13 files (+117 / −0): `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/088643091b3a7de1e7d85d439620941e922eed22"><kbd><code>0886430</code></kbd></a> Tell the user once per tab when a Nexus page change disables a feature
  - When the page check finds the download control or the collection deck spot missing, a dismissible notice explains that Nexus changed the page, that Nexus's own buttons still work, and how to report it. Adds UI.showNotice.
  - 2 files (+51 / −0): `src/content/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/b777774de13acf8f7a52e68a81375171bb77c619"><kbd><code>b777774</code></kbd></a> Render log markup through an allowlist instead of raw innerHTML
  - NXTK.setSafeHtml parses markup inertly and rebuilds only a, span, strong, b, em, i, code, br and small with class/title/target/rel and http(s) href; everything else becomes text.
  - 2 files (+39 / −1): `src/content/`, `src/shared.js`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/855e88f0f73a1881d01cdb2f5c25d866ac758f2b"><kbd><code>855e88f</code></kbd></a> Tighten isTrustedSender: a sender with no URL is accepted only outside a tab
  - Content scripts always report their page URL; a tab-attached sender without one is now refused. Adds unit tests for the sender policy.
  - 2 files (+14 / −3): `src/background.js`, `tools/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/dc46125993f20e1fe13348023e7d53056185d3d0"><kbd><code>dc46125</code></kbd></a> Retry link resolution with exponential backoff and jitter; keep a minimum hand-off gap
  - NXTK.retryDelayMs (equal-jitter exponential backoff) replaces the fixed 1.5s retry; link resolution now gets 3 attempts (1.5s..15s).
  - 6 files (+46 / −14): `src/content/`, `src/background.js`, `src/shared.js`, `tools/`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/d21a19cab9bb8c1f6188dc0751a1c799f15a914e"><kbd><code>d21a19c</code></kbd></a> Mount the collection deck reliably after SPA navigation and late hydration
  - ensureControlDeckMounted gave up silently when the deck spot was not in the DOM yet, so the deck appeared only after a reload.
  - 1 file (+43 / −4): `src/content/`

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4af0278de686babb098bd3866b35de2519a83da9"><kbd><code>4af0278</code></kbd></a> fix(report): request relay permission synchronously in the click; debug-page toggle; 2.10.3 (#19) (<a href="https://github.com/thomasthanos/nexusmods-bypass/pull/19"><kbd>#19</kbd></a>) — version → **2.10.3**
  - 22 files (+167 / −17): `src/debug-page/`, `CHANGELOG.md`, `package-lock.json`, `package.json`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/578273501927f9c8a451983fe0557698131eae80"><kbd><code>5782735</code></kbd></a> Fix popup sizing and test compatibility
  - Chromium can collapse browser-action popups when a viewport-relative width cap is applied during measurement, so the popup root now keeps its declared panel width while allowing wrapping.
  - 4 files (+43 / −5): `tools/`, `src/popup/`, `tests/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/a87b830f9229d9c07c9e5cf4ee23b0bfc6a9305b"><kbd><code>a87b830</code></kbd></a> feat(report): relay health check, specific errors, retry, GitHub fallback, relay build flag; relay fixes
  - 25 files (+836 / −74): `tools/`, `src/report-page/`, `relay/`, `src/background.js`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4df0bab21aff04d556917ef9288919c58e63b2e4"><kbd><code>4df0bab</code></kbd></a> fix: quiet API attempt errors, session-checked login errors, page-check variants
  - 5 files (+597 / −432): `src/content/`, `tools/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/ed40f44a83c49c6520fe5c3862b0ad994d96c234"><kbd><code>ed40f44</code></kbd></a> fix: one owner per download click; pin modal to clicked file; background dedupe
  - 4 files (+325 / −43): `tools/`, `src/background.js`, `src/content/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/8cb94a871ff918cf6220f373dc7b89949f743db1"><kbd><code>8cb94a8</code></kbd></a> Dedupe downloads per file_id and stop double-binding the slow-download button
  - A re-rendered download card could lose its data-nxtk-slow-bound marker and get a second click listener, and an automatic start could race a manual click; both started the same browser download twice.
  - Adds src/selectors.js, a central selector/text registry with ordered fallbacks and non-English slow-download labels;
  - 5 files (+212 / −17): `src/content/`, `src/manifest.json`, `src/selectors.js`

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/80ebbd71f7d7d0af16c87f6b1a27249994e21abf"><kbd><code>80ebbd7</code></kbd></a> Update README.md
  - 1 file (+0 / −7): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/80f60ee68fa23c4426ce03427dd5b23b2b94614c"><kbd><code>80f60ee</code></kbd></a> docs(readme): SVG pill links under Download, richer details summaries
  - 7 files (+44 / −8): `docs/`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/fbdfa2a26ad66eab4ad21adc68a38721fd7521bc"><kbd><code>fbdfa2a</code></kbd></a> docs: restyle README and all Markdown docs in the MYLE style (#21) (<a href="https://github.com/thomasthanos/nexusmods-bypass/pull/21"><kbd>#21</kbd></a>)
  - docs: restyle README and all Markdown docs in the MYLE style with shared SVG assets
  - docs: leaner README header and text, text-link nav in docs, CHANGELOG rewritten by date from the full history
  - 24 files (+546 / −1254): `docs/`, `CHANGELOG.md`, `CONTRIBUTING.md`, `PRIVACY.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/9224b37330339dfde6b5b3e61b987b9f5d94bb66"><kbd><code>9224b37</code></kbd></a> revert: restore README before redesign and remove its SVG assets
  - 84 files (+96 / −1966): `.github/`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/3908a059ae07d9a08f0f200afcd817a4f0388794"><kbd><code>3908a05</code></kbd></a> docs: compact README visuals and group licences and support links
  - 1 file (+18 / −19): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/3f1fa859de9cf1de8a87bda852ef67580cfb0cf8"><kbd><code>3f1fa85</code></kbd></a> docs: add animated glass README and expose both licence scopes and support links
  - 65 files (+1487 / −16): `.github/`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/84bb5d7a042d5c23f200bb20e086db7e845dcbab"><kbd><code>84bb5d7</code></kbd></a> docs: add animated SVG README navigation, release cards and footer
  - 20 files (+331 / −9): `.github/`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/7711b6c0abf5a72afa474631eb957f46a92cc8d9"><kbd><code>7711b6c</code></kbd></a> docs: redesign README for 3.0.0 with clear installation and support guides
  - 1 file (+177 / −99): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/92bd618f2a0b38bc287d907ee47e31740a7a8b26"><kbd><code>92bd618</code></kbd></a> docs: polish 3.0.0 release with SVG banner and collapsible sections
  - 2 files (+110 / −7): `.github/`, `internal/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/b5906a95b7a996caa052df7eecd68bd07fafb3dc"><kbd><code>b5906a9</code></kbd></a> Fix API fallback limits and stale viewer cache; prepare 2.10.1 release — version → **2.10.1**
  - Count router requests in the shared limiter and honour router 429s. Share cache initialization, invalidate viewer state after successful actions, preserve unknown update policies, and distinguish failed file lookups from empty lis…
  - 11 files (+270 / −31): `.github/`, `src/content/`, `tools/`, `CHANGELOG.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/04ad47aa1bf81a06be08dd232c10bce769d2fc1c"><kbd><code>04ad47a</code></kbd></a> Release 2.10.0: changelog, docs status, README and privacy
  - 4 files (+33 / −1): `CHANGELOG.md`, `PRIVACY.md`, `README.md`, `docs/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/91bdeee21bad806495d94d978915ac44a71c2a6c"><kbd><code>91bdeee</code></kbd></a> docs: Nexus site map and official API study with migration plan
  - 1 file (+205 / −0): `docs/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/b39bb18974c5d9fcca38f824b0f5b2b171ccbb05"><kbd><code>b39bb18</code></kbd></a> Release 2.9.0: version bump, changelog, privacy and README for reports and relay — version → **2.9.0**
  - 8 files (+31 / −10): `tools/`, `CHANGELOG.md`, `PRIVACY.md`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/90a89399fea4b6151925fcac1078e1cf9dbcfc6e"><kbd><code>90a8939</code></kbd></a> README: drop unverified ToS link
  - 1 file (+1 / −1): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/3b98b1e5ab37bbb15f6712e0dee62cb331605213"><kbd><code>3b98b1e</code></kbd></a> Release 2.8.0: changelog, version bump and README ToS disclaimer — version → **2.8.0**
  - 3 files (+44 / −1): `CHANGELOG.md`, `README.md`, `src/manifest.json`

### Merged

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/0de791a95e99fd84c8ca2318342abadce9a68543"><kbd><code>0de791a</code></kbd></a> Merge pull request #16 from thomasthanos/fix/live-test-2.10.1 (<a href="https://github.com/thomasthanos/nexusmods-bypass/pull/16"><kbd>#16</kbd></a>)
  - 2.10.2: live-test fixes (duplicate downloads, false errors), large-run confirm, report sending, UI polish
  - 40 files (+2176 / −558): `tools/`, `src/content/`, `src/report-page/`, `relay/`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/e808141a8c8cf337517817be30af461ef9130556"><kbd><code>e808141</code></kbd></a> Merge pull request #13: robustness, responsive UI and diagnostics (<a href="https://github.com/thomasthanos/nexusmods-bypass/pull/13"><kbd>#13</kbd></a>) — version → **2.9.0**
  - Robustness fixes and review follow-ups (2.8.0)
  - 68 files (+8187 / −80): `tools/`, `src/content/`, `relay/`, `.github/`, `locales`

## 2026-10-04

**Versions / tags:** **2.7.4**

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/c6e75638b443d13bd45b4e74cb21cca0e3e24680"><kbd><code>c6e7563</code></kbd></a> Release 2.7.4 — version → **2.7.4**
  - Smallest files first, removed mods skipped without stopping the run, a lone Cloudflare answer skipped, and the Nexus page and API check. Bump to 2.7.4: manifest, changelog, banner and spec badges, store notes.
  - 5 files (+10 / −8): `.github/`, `CHANGELOG.md`, `internal/`, `src/manifest.json`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/7f293148a3fa924046bcfdb6c6e22b146ae2ce55"><kbd><code>7f29314</code></kbd></a> Name a skipped file's reason without the error advice
  - Run end to end in Chromium, a skipped mod logged as "Skipped: Medium (This mod has been hidden or removed. The mod is no longer available on Nexus Mods.
  - 2 files (+9 / −5): `src/content/`, `tools/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/672e030a0794fc3f5144b5af864acd0c6094fbd2"><kbd><code>672e030</code></kbd></a> Check Nexus pages for what the extension relies on, and name API changes
  - A Nexus redesign showed only as a feature quietly doing nothing: the deck not mounting when findCollectionHost found no spot, the game id coming back empty, a file page with no download control.
  - content/page-check.js runs on mod, file and collection pages after the page settles, and again before calling anything missing.
  - 25 files (+750 / −8): `src/content/`, `tools/`, `CHANGELOG.md`, `src/manifest.json`, `locales`

### Merged

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/80c9beba6f5f9a986f1c8e254818f443e6afb631"><kbd><code>80c9beb</code></kbd></a> Merge pull request #11 from torkelicious/main (<a href="https://github.com/thomasthanos/nexusmods-bypass/pull/11"><kbd>#11</kbd></a>)
  - improvements to how game IDs are detected and how requirements tab links are intercepted
  - 1 file (+63 / −38): `src/content/`

## 2026-09-30

### Added

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/843ea8c6a1d21553774b4e5dd0362226bb071573"><kbd><code>843ea8c</code></kbd></a> [game-id] support
  - both [data-game-id] and [game-id] are valid depending on context, they must both be scanned for
  - 1 file (+50 / −30): `src/content/`

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/20bcdcfaeabb78b9459e0917f6ae757ecee4f256"><kbd><code>20bcdcf</code></kbd></a> #action-vortex detetction
  - 1 file (+1 / −1): `src/content/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/11b207b70ce0f6bb792c84c41b05c67a6e35f0b3"><kbd><code>11b207b</code></kbd></a> requirements via composedpath
  - works better through shadow dom , and will ignore already handled events.
  - 1 file (+12 / −7): `src/content/`

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/95e5351cb9370e090c55860f2a719f6b7ef63abe"><kbd><code>95e5351</code></kbd></a> Skip removed mods, survive a lone Cloudflare answer, download smallest first
  - A collection run treated a single Cloudflare answer as a site-wide block and stopped, and a removed mod got a pointless second attempt and was reported as a failure.
  - shared.js holds the queue policy both queues use: queueSkipReason names a gone mod (mod_unavailable, file_not_found, moderation_hold) as a skip, and a Cloudflare answer as one while fewer than CLOUDFLARE_SKIP_LIMIT (3) came in a r…
  - 21 files (+974 / −13): `src/content/`, `tools/`, `CHANGELOG.md`, `README.md`, `locales`

## 2026-09-29

**Versions / tags:** tag `2.7.3` · **2.7.3**

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/645aa9201a8dcf125c98ee6285825cc23bfe1612"><kbd><code>645aa92</code></kbd></a> Ignore Cloudflare's passive bot check and release 2.7.3 — version → **2.7.3**
  - Cloudflare adds /cdn-cgi/challenge-platform/scripts/jsd/main.js to ordinary pages as a passive bot check.
  - response-classifier.js only takes a challenge's own challenge-platform/h/&lt;v&gt;/orchestrate/ path as a marker; the Cf-Mitigated header, _cf_chl_opt and the other markers are unchanged.
  - 10 files (+56 / −13): `.github/`, `tools/`, `CHANGELOG.md`, `README.md`

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/03d6b490815745bb4d6a72ad2ddd09554b79835a"><kbd><code>03d6b49</code></kbd></a> Make README and animated SVGs more compact — tagged `2.7.3`
  - 4 files (+168 / −314): `.github/`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/0b036b3d04f83f67001862ee1ea9b58dae813131"><kbd><code>0b036b3</code></kbd></a> Redesign README with animated SVG hero and source map
  - 5 files (+463 / −344): `.github/`, `README.md`

## 2026-09-27

**Versions / tags:** tag `2.7.2` · **2.7.2**

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/1bd1a222e583d110038ea513a63ee7ad5810f1bf"><kbd><code>1bd1a22</code></kbd></a> Read Vortex links on older Chromium and release 2.7.2 — version → **2.7.2**, tagged `2.7.2`
  - Chromium before 130 parsed a URL of a scheme it did not know as an opaque path: nxm://game/mods/1/files/2 had an empty hostname and the pathname //game/mods/1/files/2.
  - download-url-parser.js splits an nxm:// link by hand instead of through URL. The authority must be a bare game domain, which also rules out credentials and a port; the path, key, expiry and user checks are unchanged.
  - 25 files (+163 / −45): `tools/`, `.github/`, `CHANGELOG.md`, `README.md`, `locales`

## 2026-09-17

**Versions / tags:** **2.7.1**

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/a9e104a80a7dc757c6937cad135128d660ca547c"><kbd><code>a9e104a</code></kbd></a> Recognise removed-mod notices and release 2.7.1 — version → **2.7.1**
  - Nexus serves a removed, hidden, unpublished or missing mod as a single site notice where the mod page was.
  - response-classifier.js reads the notice title from its markup (Removed by author, Removed by staff, Hidden mod, Not published, Not found) and returns mod_unavailable.
  - 25 files (+260 / −31): `tools/`, `.github/`, `src/content/`, `CHANGELOG.md`, `locales`

## 2026-09-14

**Versions / tags:** **2.7.0**

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/8f4ee29ddc9009d4d2bed2c7e8149cb7ce6d63af"><kbd><code>8f4ee29</code></kbd></a> Fix Wabbajack deck placement and release 2.7.0 — version → **2.7.0**
  - This release fixes imported Wabbajack modlists replacing a collection deck and leaving the page in a broken state by mounting the deck once, restoring the collection deck correctly on close, and keeping it in the content column wh…
  - 12 files (+132 / −40): `src/content/`, `.github/`, `tools/`, `CHANGELOG.md`

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/6829a96cbf6e33cadb3def4db2eb80f44062e913"><kbd><code>6829a96</code></kbd></a> Refresh store listing and app descriptions
  - This update aligns the extension copy with the current download workflow: auto-starting Nexus Mods downloads, queueing full collections to Vortex or the browser, and skipping files already present.
  - 15 files (+26 / −44): `.gitignore`, `internal/`, `locales`

## 2026-09-13

### Added

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/0ba1fcd9790a1d8c5816c1989c63cd7d42eb129e"><kbd><code>0ba1fcd</code></kbd></a> Add release gate, worker refactor & tests
  - Add CI release-gate workflow and a build script; centralise shared logic and tighten worker/page interactions.
  - 27 files (+898 / −1024): `src/content/`, `src/popup/`, `.github/`, `.gitignore`, `locales`

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/b783a49d9c04ee12b9978c79cafd6a8aace1a9fd"><kbd><code>b783a49</code></kbd></a> Load page features on demand and drop downloads.ui
  - The collection deck, settings dialog, Wabbajack importer and bug report builder are bundles the worker injects with chrome.scripting when a page first needs them, so every Nexus page loads 174 KB of script instead of 368 KB.
  - 20 files (+3249 / −2724): `src/content/`, `tools/`, `CHANGELOG.md`, `PRIVACY.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/0387ab55d10012f13a89520130980bd3ce44bce4"><kbd><code>0387ab5</code></kbd></a> Share one download-link parser and track the release tools
  - Move link parsing out of nnw.js into src/download-url-parser.js, original code under the main licence, loaded by the content scripts and the worker.
  - 23 files (+5635 / −340): `tools/`, `src/content/`, `.gitignore`, `CHANGELOG.md`

## 2026-09-12

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/d90fc0380e1f44be002a47875de285977abe57dc"><kbd><code>d90fc03</code></kbd></a> Update README SVG version to 2.6.4
  - 3 files (+3 / −3): `.github/`, `README.md`

## 2026-09-11

**Versions / tags:** tag `2.6.4` · **2.6.4**

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/642ffe59170dcacb8e8d491ed15390418466ef39"><kbd><code>642ffe5</code></kbd></a> Remove development tools from repository — tagged `2.6.4`
  - Keep the local test and packaging utilities ignored while removing them from the published source tree.
  - 9 files (+2 / −4939): `tools/`, `.gitignore`

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/c9b869e6921111bc0e13a15e9d74a7246117b3db"><kbd><code>c9b869e</code></kbd></a> Fix Firefox duplicate collection downloads — version → **2.6.4**
  - Serialize terminal download handling, retire exact browser download IDs before retrying, and guard queue state transitions against Stop/Restart races.
  - 30 files (+6481 / −253): `tools/`, `src/content/`, `.gitignore`, `CHANGELOG.md`, `locales`

## 2026-09-07

**Versions / tags:** **2.6.2**

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/cc1f46951f525b1c7f5a48324eac997caa00108d"><kbd><code>cc1f469</code></kbd></a> Fix download validation and history — version → **2.6.2**
  - This release fixes several NDC download issues: transfers are validated against the server Content-Length instead of Nexus's often-wrong listing, selected downloads and collection updates now record history so Skip Downloaded stop…
  - 6 files (+122 / −34): `.github/`, `CHANGELOG.md`, `README.md`, `src/background.js`

## 2026-09-06

**Versions / tags:** **2.6.1**

### Added

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/dabba8bee3228d86c76b030262fceb15cffd539a"><kbd><code>dabba8b</code></kbd></a> Add queue ETA, improve Wabbajack import & rating
  - Measure and show a remaining-time ETA for queue runs (measured from finished files). Add UI/CSS for ETA and a decorated rating prompt; rating link now chosen by extension listing id (getStoreListing) rather than user agent.
  - 24 files (+536 / −45): `src/content/`, `src/popup/`, `CHANGELOG.md`, `README.md`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/b29a797647e30e2b74d5d5a6888000d94863a043"><kbd><code>b29a797</code></kbd></a> Remove DebugLogs setting and add activity trail
  - Remove the DebugLogs UI option and its translations, and replace noisy verbose logging with a small recorded activity trail included in bug reports.
  - 17 files (+81 / −107): `src/content/`, `CHANGELOG.md`, `src/shared.js`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/d7c776f19ff0f5f422c2c1b7771ad66ec4bec43b"><kbd><code>d7c776f</code></kbd></a> Add review prompt, improve NDC handling & UI
  - Introduce a one‑time review prompt in the deck (shown after ≥5 finished files) with store‑specific review URLs and storage helpers (wasRatingPrompted/markRatingPrompted). Update onboarding, popup and many locale strings;
  - 26 files (+712 / −354): `src/content/`, `src/onboarding/`, `.github/`, `CHANGELOG.md`, `locales`

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/a3e0baf9ece0754b60219164f36957b79ec5748f"><kbd><code>a3e0baf</code></kbd></a> Make rating prompts milestone-based
  - Replace the old one-time rating prompt with a milestone-driven flow. Add persistent rating state (RATING_STATE_KEY) and milestones ([25,120,500,1500]) with a 21-day gap.
  - 22 files (+351 / −192): `src/content/`, `src/popup/`, `CHANGELOG.md`, `README.md`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/6ae045cdbd960e1fdac37bfede871c2a9a4c8599"><kbd><code>6ae045c</code></kbd></a> patch
  - 2 files (+18 / −0): `CHANGELOG.md`, `src/content/`

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/2f2c7e0c897d35d4b60cfbf080a771b7291849bf"><kbd><code>2f2c7e0</code></kbd></a> Wabbajack import, error-reporting and UI fixes
  - Enhance Wabbajack import, diagnostics and UI behavior.
  - Key changes: - Wabbajack importer: parse only the Archives array (much lower memory), raised modlist limit to 256MiB, added archive-size safeguards and downloader labels; improved error handling.
  - 24 files (+1087 / −178): `src/content/`, `.github/`, `CHANGELOG.md`, `README.md`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4bb95ac99826c56d9bfc805d11caea632644dad8"><kbd><code>4bb95ac</code></kbd></a> Deeper Download Fallbacks for Legacy URLs (fix for issue #3)
  - 1 file (+69 / −12): `src/content/`

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4c3cdd254f435429c99d379c9f84853d88d47435"><kbd><code>4c3cdd2</code></kbd></a> Release 2.6.1 — update manifest, docs & privacy — version → **2.6.1**
  - Bump extension version to 2.6.1 and mark the release in CHANGELOG. Clarify ad-timer cookie behavior and collection-run requirements, add a short in-memory action list and expand the bug-reporter description in PRIVACY.md.
  - 5 files (+42 / −22): `CHANGELOG.md`, `PRIVACY.md`, `README.md`, `internal/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/5279ed17fcd40314f4d98472bd88e75ecee787d4"><kbd><code>5279ed1</code></kbd></a> Refresh contributors cache

## 2026-09-05

### Added

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/560c8bf09454348c4050d4408e16e3b165b9a75f"><kbd><code>560c8bf</code></kbd></a> Implement DeepSeek architectural review recommendations
  - 1. Add 5-minute periodic reconcile alarm to resume stuck jobs
  - 2. Add memory cleanup for stale pending terminal downloads (1 hour TTL)
  - 2 files (+19 / −3): `src/background.js`, `src/content/`

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/de10710ac64a89a1fc3094f2d242943a39048a37"><kbd><code>de10710</code></kbd></a> Optimize background resilience: implement dead-man's switch for reconcile alarm
  - This eliminates idle CPU usage. The 5-minute alarm is now pushed forward dynamically during active downloads. If the queue is completely idle, the alarm is completely cleared.
  - 1 file (+20 / −3): `src/background.js`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4420858ae0cd6ba3996188a434f03be959f83287"><kbd><code>4420858</code></kbd></a> Harden download URL parser: scope to fileId, segregate NMM/browser flows, reject ambiguous matches
  - The download-URL parser now threads the requested fileId through every extraction
  - strategy (JSON traversal, embedded attributes, bare CDN scanning) so that multi-file
  - 3 files (+289 / −130): `src/content/`, `CHANGELOG.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/e332ef402152b262b062af360ea1434c20c60b6e"><kbd><code>e332ef4</code></kbd></a> Refactor Wabbajack modlist importing
  - 8 files (+610 / −351): `src/content/`, `CHANGELOG.md`, `src/background.js`, `src/manifest.json`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/d65eb5f987b5d1272a8def25cffc03374acb51c7"><kbd><code>d65eb5f</code></kbd></a> notes
  - 9 files (+17 / −2): `src/content/`, `src/background.js`, `src/shared.js`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/0bbe1d29e74840ccf198bcbde6bc392c8fcd64c1"><kbd><code>0bbe1d2</code></kbd></a> Refine retry logic and remove debug clutter
  - This change removes a large amount of explanatory inline comments that were no longer useful, while keeping the actual behavior intact.
  - 15 files (+3 / −256): `src/content/`, `src/popup/`, `src/onboarding/`, `.gitignore`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/83187e0e152f65e1c24f8d4d063f69b92745f14f"><kbd><code>83187e0</code></kbd></a> patch
  - 6 files (+3 / −998): `tools/`, `.gitignore`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/d096a6a1b5e8aa800f2511de79da76f79ad99582"><kbd><code>d096a6a</code></kbd></a> Updated Extension Internals and Localization
  - ## Changelog
  - ### Localization - Updated translations across multiple languages (de, el, en, es, fr, it, ja, ko, pl, pt_BR, ru, tr, zh_CN) to improve accuracy and add missing strings.
  - 16 files (+15990 / −15980): `src/content/`, `src/background.js`, `locales`

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/613d655b510eabfa82293a1e64755765f8e5ee61"><kbd><code>613d655</code></kbd></a> Refresh repository cache
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/c70fe3362d8ff03a455a8015c5ad86cd0671a90f"><kbd><code>c70fe33</code></kbd></a> Add GPL-3.0-or-later license for nnw.js
  - Mark src/content/nnw.js as GPL-3.0-or-later and include the full GPLv3 text (src/LICENSE-GPL-3.0-or-later.txt). Update nnw.js header with SPDX and upstream attribution (Nexus No Wait ++).
  - 7 files (+742 / −19): `CONTRIBUTING.md`, `LICENSE`, `README.md`, `THIRD-PARTY-NOTICES.md`

## 2026-08-30

**Versions / tags:** **2.6.0**

### Added

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/e5adc3708833909dfc3f1144251635d9dc80d313"><kbd><code>e5adc37</code></kbd></a> Give the Wabbajack import its own info dialog
  - Matches the info button that already sits beside "Import downloaded mods", so the two imports in the Actions row read the same way.
  - The dialog announces itself as a dialog, takes focus on open and restores it on close, which the older info dialog it is modelled on does not yet do. It is registered with the deck-bound modals so teardown settles it.
  - 14 files (+265 / −1): `src/content/`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/11c8961de88ae13a33dc39e19bce16ea1395ced4"><kbd><code>11c8961</code></kbd></a> Offer the Wabbajack import from the collection deck as well
  - The settings dialog reaches every Nexus page, but when a collection deck is already open that is where the user is looking, and its Actions row is where the other import lives.
  - NDC carries the flag, set on both init paths and refreshed by applySettings, so the deck renders against it rather than reading storage while it builds.
  - 3 files (+15 / −3): `src/content/`, `CHANGELOG.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/8fb8948db22c58d51c7aa592a81b9ed6be7c3831"><kbd><code>8fb8948</code></kbd></a> Add the Wabbajack import UI behind a beta switch, off by default
  - Turning on "Wabbajack modlist import (beta)" in the page settings adds an Import Wabbajack modlist button to that dialog.
  - Picking a file parses it, reports how many of its archives were queued and how many were left out, and mounts the normal collection deck with the result.
  - 18 files (+360 / −2): `src/content/`, `CHANGELOG.md`, `src/background.js`, `src/shared.js`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4aa398a80c91f144dabf1f51c44d09cc00806d69"><kbd><code>4aa398a</code></kbd></a> Add a dependency-free .wabbajack modlist reader
  - Foundation for importing a Wabbajack modlist as a download queue. No UI yet — this is the parsing layer plus its tests.
  - The userscript this comes from pulls zip.js from a CDN, which Manifest V3 blocks outright, so the ZIP reading is ours: end-of-central-directory scan, ZIP64 for the multi-gigabyte archives real modlists produce, central directory w…
  - 4 files (+518 / −0): `tools/`, `src/content/`, `src/manifest.json`

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/186d148d0505887650c8109b3c9e0397d298f424"><kbd><code>186d148</code></kbd></a> Remove unused folder
  - 2 files (+0 / −2050): `you need to add this (gitgnore this folder)/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/20614f9b28be2069c9f8950a0e979308840cb463"><kbd><code>20614f9</code></kbd></a> Update manifest.json — version → **2.6.0**
  - 1 file (+2 / −2): `src/manifest.json`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/30c83209ce201ced36251691b3db3aa108a6eb90"><kbd><code>30c8320</code></kbd></a> Name every skipped archive, guard the import, and see Cloudflare in the worker
  - A feature-by-feature audit of the userscript against the port turned up 133 capabilities: 76 ported, 31 already covered by the extension, 5 deliberately excluded, and 18 genuinely missing. These are the ones worth fixing now.
  - The worst was self-inflicted. wabbajack.js records a reason for every archive it cannot queue, and the info dialog promised those entries are named - but the summary printed only a count, so a user importing a list with thirty non…
  - 17 files (+148 / −36): `CHANGELOG.md`, `src/background.js`, `src/content/`, `tools/`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/f23619852e3cf2aa4aa793b802b66dd9cc16d898"><kbd><code>f236198</code></kbd></a> update
  - 14 files (+40 / −39): `.gitignore`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/523e819b93c0774043ab2e10fa78deb199b35e3a"><kbd><code>523e819</code></kbd></a> Skip the Nexus ad timer, and map a modlist onto the existing queue
  - Ad timer: Nexus decides whether a download's ad countdown has elapsed from a first-party "ab" cookie shaped &lt;group&gt;|&lt;unix seconds&gt;.
  - The cookie is first-party, expires by itself after five minutes and is never read back. PRIVACY.md said the extension makes only the requests the browser would make on its own;
  - 19 files (+172 / −63): `src/content/`, `PRIVACY.md`, `tools/`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/7b7959cd830e5f031658ad1d0c62ea52f7cb7e09"><kbd><code>7b7959c</code></kbd></a> Harden the collection queue, cut steady-state cost, close a11y and i18n gaps
  - Queue and worker state: - Job state was persisted by writing a whole job object back, but callers held that snapshot across several awaits.
  - Manual downloads: - The capture-phase click interceptor cancelled Nexus's own Manual and Slow download buttons and substituted its own resolution.
  - 31 files (+773 / −208): `src/content/`, `src/popup/`, `tools/`, `.gitignore`, `locales`

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/b17379d802a063d9abf574a8e7daec3647b3541b"><kbd><code>b17379d</code></kbd></a> resolve stuck manual downloads and missing Vortex imports in collections
  - fix(downloads): resolve click interceptor locks and manual import issues for collections
  - Release failed downloads back to native Nexus handlers on specific resolution errors (no_download_url, no_nmm_link, unsafe_download_url) - Bypass click interception when modifier keys (Ctrl, Shift, Alt) or middle-click are used -…
  - 28 files (+2462 / −154): `src/content/`, `tools/`, `you need to add this (gitgnore this folder)/`, `CHANGELOG.md`, `locales`

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/9ef54df23986f7cd1665f1e3d8bd172d67511907"><kbd><code>9ef54df</code></kbd></a> Bump cache for text position fix
  - 1 file (+1 / −1): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/74ae5512120a8a8ff6b5a78aab50ec63f1b66cf0"><kbd><code>74ae551</code></kbd></a> Adjust text positioning in spec-nexus-v2.svg
  - 1 file (+2 / −2): `.github/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/79d5610c740573c995b2c711a659bffc32dce544"><kbd><code>79d5610</code></kbd></a> Bust cache for spec-nexus-v2.svg
  - 1 file (+1 / −1): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/584d5e55811dafef4c489b64357aa1592335029c"><kbd><code>584d5e5</code></kbd></a> Fix 2.4.2 to 2.6.0 in spec-nexus-v2.svg
  - 1 file (+1 / −1): `.github/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/9bb904ecae7d89ebab037351444f23444a96c11e"><kbd><code>9bb904e</code></kbd></a> Rename SVGs to force github cache invalidation
  - 3 files (+2 / −2): `.github/`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/702cd0e46424c7548b343d237a93053f5c9eb2f1"><kbd><code>702cd0e</code></kbd></a> Bust camo cache for spec-nexus.svg again
  - 1 file (+224 / −224): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/3cbc183066bb1f37d94d78df58998faa409b10c8"><kbd><code>3cbc183</code></kbd></a> Update spec-nexus.svg lines count to 12.8k
  - 1 file (+2 / −2): `.github/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/de9c125686b0d5a4e00fd2c44faf81c58698d822"><kbd><code>de9c125</code></kbd></a> Update spec-nexus.svg to 2.6.0
  - 1 file (+1 / −0): `.github/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4c58a9ac53d0860224040958a597e936bf84169b"><kbd><code>4c58a9a</code></kbd></a> Bust camo cache for SVG assets
  - 1 file (+2 / −2): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/428a7ef8d17b0be6c20ad0133e33d65e67cb807a"><kbd><code>428a7ef</code></kbd></a> Update version to v2.6.0 in banner
  - 1 file (+1 / −1): `.github/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/955481d985c2aa4e1fe93911e9ea8fc63934a1db"><kbd><code>955481d</code></kbd></a> Update README.md with Wabbajack modlist import feature
  - 1 file (+2 / −1): `README.md`

## 2026-08-28

**Versions / tags:** tag `2.5.2` · **2.5.2** · **2.5.1**

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/03118e0eb5c9d05e9a9c41190951fff77d456968"><kbd><code>03118e0</code></kbd></a> patch
  - 3 files (+11 / −9): `.github/`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/be104911137ebb1100f577e861435e6303fa788d"><kbd><code>be10491</code></kbd></a> patch
  - 5 files (+74 / −4): `.github/`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/d128a0c5af065dfde862b7caa8de417d89d23346"><kbd><code>d128a0c</code></kbd></a> patch
  - 4 files (+66 / −11): `.github/`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/1227314587a0a2fcd09c381b0405b00a1d3c5583"><kbd><code>1227314</code></kbd></a> patch
  - 2 files (+13 / −2): `.gitignore`, `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/eaece6ee510c048c20c0f88ece5a2c68562569f4"><kbd><code>eaece6e</code></kbd></a> Release v2.5.2 — Popup and page settings redesign — version → **2.5.2**
  - 2 files (+3 / −1): `CHANGELOG.md`, `src/manifest.json`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4179e47f8996418ccb307efb118c50c719ef25ae"><kbd><code>4179e47</code></kbd></a> Redesign popup and page settings layout
  - Popup: one stable height across both tabs (Controls and Help & Bugs differed by ~170px, so the window jumped on every switch), 380px wide, version moved into a header pill, sliding tab indicator, and the Help tab shows the three s…
  - Page settings: two proportioned columns instead of grid areas with a row span, which had stretched Language, Files & Pacing and Advanced past their content and left the dead space inside those cards.
  - 7 files (+441 / −284): `src/popup/`, `src/content/`, `CHANGELOG.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/4f4f3361a0ec97688b735d75fcafff2cceea9ab2"><kbd><code>4f4f336</code></kbd></a> Update .gitignore
  - 1 file (+1 / −0): `.gitignore`

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/e807883198f9fc983069782cbb7bd7ae8bcc2b1d"><kbd><code>e807883</code></kbd></a> Fix Vortex preflight and compact settings UI — version → **2.5.1**
  - This update tightens the Vortex download flow by confirming the app is running before collection links are sent, honoring browser fallback choice, and showing explicit 'Sent to Vortex' status instead of claiming a file downloaded.…
  - 10 files (+426 / −20): `src/content/`, `src/popup/`, `tools/`, `CHANGELOG.md`

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/dc5a224d758fdfeab45a576233681cd30da314ca"><kbd><code>dc5a224</code></kbd></a> Update README.md
  - 1 file (+3 / −3): `README.md`

### Merged

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/dc24d7793632ad20b69fda2aa704a414e6c8b58a"><kbd><code>dc24d77</code></kbd></a> Merge branch 'main' of https://github.com/thomasthanos/nexusmods-bypass — tagged `2.5.2`
  - 1 file (+1 / −0): `.gitignore`

## 2026-08-27

**Versions / tags:** tag `v2.5.0` · **2.5.0** · **2.4.5**

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/c7f70f063591920a7d7c488297c48ebda7f0caa3"><kbd><code>c7f70f0</code></kbd></a> Release v2.5.0 — Tabbed popup UX & donation options — tagged `v2.5.0`
  - 2 files (+8 / −1): `CHANGELOG.md`, `src/popup/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/21f3b723f03b24d99385662f5bf47967ab468e1d"><kbd><code>21f3b72</code></kbd></a> patch
  - 13 files (+156 / −195): `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/a8f6f8f2f1cd719f81532c6951f6baaeaafe1418"><kbd><code>a8f6f8f</code></kbd></a> Update manifest.json — version → **2.5.0**
  - 1 file (+8 / −4): `src/manifest.json`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/eff7731719dfb2c3048caed7b63a3ff5ac381868"><kbd><code>eff7731</code></kbd></a> Refresh onboarding and popup UX
  - This commit modernizes the onboarding page with a richer hero layout, SVG iconography, responsive scaling, and stronger visual polish.
  - 5 files (+633 / −189): `src/popup/`, `src/onboarding/`

### Fixed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/d0856ad0f65c8b75d25f01c275b723eb49d0a1c0"><kbd><code>d0856ad</code></kbd></a> Release 2.4.5 — Cloudflare fallback & fixes — version → **2.4.5**
  - Bump version to 2.4.5 and add Cloudflare fallback UX and controls. Introduces a CloudflareFallback setting, watchdog/deadline for native fallback, activity tracking (setActivity/describeActivity), and richer session info in bug re…
  - 28 files (+1343 / −90): `src/content/`, `src/popup/`, `CHANGELOG.md`, `README.md`, `locales`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/1cd42ca46a46884b92eee2f9d978727bdc85ffe3"><kbd><code>1cd42ca</code></kbd></a> Handle Cloudflare fallback and close-tab races
  - When Cloudflare challenges a hidden download request, the flow now falls back to Nexus's native download control or opens the file page for verification instead of retrying a request that cannot complete the challenge.
  - 3 files (+323 / −11): `src/content/`, `CHANGELOG.md`

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/3c18558dc6126668d477dde216e6b56c447df728"><kbd><code>3c18558</code></kbd></a> docs: Add official extension store links
  - 1 file (+3 / −3): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/a5065df72507e1eb25b138e92116e628c92f3c5e"><kbd><code>a5065df</code></kbd></a> docs: Emphasize official store installation and hide manual methods
  - 1 file (+15 / −9): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/c465955742760c1134f2c63eb10a765a8c4b7cf4"><kbd><code>c465955</code></kbd></a> docs: Update installation guide to use GitHub Releases
  - 1 file (+11 / −14): `README.md`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/c2e42858959d1186e80f70d489e8f99a70f418ea"><kbd><code>c2e4285</code></kbd></a> Add SECURITY.md
  - 1 file (+24 / −0): `SECURITY.md`

## 2026-08-24

**Versions / tags:** **2.4.4**

### Added

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/cf0a3c985da0e60c707487bede52d9d5b8d4946f"><kbd><code>cf0a3c9</code></kbd></a> Restructure repo, add Firefox build & bump v2.4.4 — version → **2.4.4**
  - Move extension sources into src/ and internal assets/docs into internal/; update .gitignore accordingly. Bump manifest version to 2.4.4 and update README/CHANGELOG with Firefox packaging and fixes.
  - 50 files (+258 / −1477): `nexus.mods.bypass/`, `.gitignore`

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/2246c8667f7512e73027915b519f8fa0a4928d7d"><kbd><code>2246c86</code></kbd></a> refactor: make NexusMods Bypass a standalone repository
  - 258 files (+220 / −55292): `An1me_tracker/`, `.github/`, `{nexus.mods.bypass/`, `auto-liker-extension/`
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/727b706e1c13488d9e42c943bd781c4b14ffe771"><kbd><code>727b706</code></kbd></a> Restore store-assets to version control
  - e8911bd untracked nexus.mods.bypass/internal/store-assets on a misread request; promo was the intended target and has never been tracked at all. The nine listing assets and their .gitignore entry are back exactly as they were.
  - The LICENSE path corrections from that commit stand — they fixed references broken by the src//internal/ restructure and are unrelated to what is tracked.
  - 11 files (+53 / −6): `nexus.mods.bypass/`, `.gitignore`

### Docs

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/e8911bd69fb998da77ab65c3eca0c4f43d14e4e1"><kbd><code>e8911bd</code></kbd></a> Stop tracking store-assets; fix stale paths in LICENSE
  - The 3.3 MB of screenshots, promo tiles and marquee art under nexus.mods.bypass/internal/store-assets are listing artwork: no build step reads them, the packager's allowlist has never included them, and every clone was carrying the…
  - LICENSE section 3 still pointed at nexus.mods.bypass/icons/ and nexus.mods.bypass/store-assets/, both moved by the src//internal/ restructure in the previous commit.
  - 12 files (+10 / −56): `nexus.mods.bypass/`, `.gitignore`, `LICENSE`

## 2026-08-23

<details>
<summary><sub>4 commits for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/fa07b1d5bbb283115c67f4d8e9699fdf5f6c81b6"><kbd><code>fa07b1d</code></kbd></a> patch
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/073792bc04fafdd2dcbd36a82ff240cde4bb9bba"><kbd><code>073792b</code></kbd></a> Add an1me gateway, auto-resume & metadata fixes
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/0c9fa81ab5b0d69675a3561c1d8105816249197e"><kbd><code>0c9fa81</code></kbd></a> Update manifest.json
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/edb0886748ee989f40888d4a4620eaabe9a0b19c"><kbd><code>edb0886</code></kbd></a> Auto-pick premium server variants

</details>

## 2026-08-22

<details>
<summary><sub>4 commits for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/78016d6b6623ee889d11accfc10f41744ac788f3"><kbd><code>78016d6</code></kbd></a> Update manifest.json
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/6ac18ebb4ee1b9e4dc98d90b413239da7848803d"><kbd><code>6ac18eb</code></kbd></a> Add in-page bridge for an1me fetches
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/5f7089b392ad31dd72e79a165a0e3385d17f6611"><kbd><code>5f7089b</code></kbd></a> Revert "patch"
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/992dccbf523662527f1c46c128bd07b14bf52fda"><kbd><code>992dccb</code></kbd></a> patch

</details>

## 2026-08-17

<details>
<summary><sub>4 commits for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/e54972ffc7bece82f526577da493a9ba07faaaf6"><kbd><code>e54972f</code></kbd></a> adblcoker
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/932010a461b38f421864cfb97a1874523272dcab"><kbd><code>932010a</code></kbd></a> patch
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/7efc1d56b6a50f2e5df26857519fa566aead9c77"><kbd><code>7efc1d5</code></kbd></a> Update manifest.json
- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/ad814ad461dcc1903aaf6232c4141810ba677d75"><kbd><code>ad814ad</code></kbd></a> patch

</details>

## 2026-08-16

<details>
<summary><sub>1 commit for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/e8974d62c3be3ebb61677ea92d34928a9a081506"><kbd><code>e8974d6</code></kbd></a> Improve caching, UI, AniList episode placeholders

</details>

## 2026-08-10

**Versions / tags:** **2.4.3**

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/f46b3d0cacce086c6b6f09f586c1f5db6282fb49"><kbd><code>f46b3d0</code></kbd></a> nexus.mods.bypass: v2.4.3 — remove HideDownloadBar — version → **2.4.3**
  - Bumps nexus.mods.bypass to 2.4.3 and removes the profile‑wide HideDownloadBar feature.
  - 28 files (+417 / −255): `nexus.mods.bypass/`, `.github/`, `.gitignore`, `PRIVACY.md`

## 2026-08-06

<details>
<summary><sub>1 commit for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/0fb77e2f4d7c2965e711a1cfe80157ee583af577"><kbd><code>0fb77e2</code></kbd></a> Update .gitignore

</details>

## 2026-08-04

### Changed

- <a href="https://github.com/thomasthanos/nexusmods-bypass/commit/05b827a99196733d82f7f36bc23cb77a0e3541bf"><kbd><code>05b827a</code></kbd></a> patch
  - 283 files (+84861 / −0): `.github/`, `An1me_tracker/`, `nexus.mods.bypass/`, `auto-liker-extension/`

<img src="docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="docs/assets/footer.svg?v=52bfdbe" alt="Built with care by ThomasT. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
