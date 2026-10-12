<p align="center">
  <img src="docs/assets/header-changelog.svg" alt="Changelog" width="100%" />
</p>

<p align="center"><sub><a href="README.md">← README</a> · <a href="PRIVACY.md">Privacy</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="CHANGELOG.md">Changelog</a></sub></p>

<img src="docs/assets/divider.svg" alt="" width="100%" />

Notable changes to NexusMods Bypass, newest first and grouped by commit date. Versions follow the
`manifest.json` version; **releases** are marked where they landed, and Git tags are shown in brackets.
Derived from the Git history (149 commits on `main`, 2026-08-04 → 2026-10-12); trivial commits
(cache busts, "patch", merge commits) are folded into the change they belong to.

## 2026-10-12

**Releases 2.8.0, 2.8.1, 2.9.0, 2.10.0, 2.10.1 `[2.10.1]`, 2.10.2, 2.10.3 and 3.0.0 `[3.0.0]`**

- **3.0.0** — major cumulative release (published with Chrome and Firefox ZIPs and SHA-256 checksums); README redesign tried and reverted the same day.
- **2.10.3** — the relay permission is requested synchronously in the Send click; "Turn on debug logs" on the debug page (#19).
- Debug log page: live view, level filter, search, follow mode, clear, `.txt`/`.json` export (#18).
- Relay: Discord embeds coloured by severity, Page field, embed limits, 10-minute dedupe of identical auto errors; GitHub fallback adds area labels; shared KV rate limiting.
- Report workspace redesign (summary, category, steps, expected result, reviewed JSON preview, save/copy); relay deployed and enabled.
- **2.10.2** — one owner per download click, requirements modal pinned to the clicked file, background dedupe; confirm before more than 50 mods; quieter API-attempt errors; relay health check, specific errors, retry and GitHub fallback; themed scrollbars and accessible custom selects (#16).
- **2.10.1** — API fallback limits and stale viewer-cache fixes.
- **2.10.0** — official Nexus API (v2 GraphQL) for collections, revisions, game IDs and file lists with legacy fallback, shared throttle/429 backoff/caching; revision and update badges, optional curator update policy, click-only Endorse/Track, Wabbajack archive identification by MD5; weekly schema watch; Nexus site/API map doc (#13).
- **2.9.0** — opt-in report system: redaction, debug ring buffer, report page with preview, relay send; CI manifest/permission watch and optional Discord notifications.
- **2.8.1** — responsive layer for all injected UI (720p–4K, 100–150% zoom) with Playwright layout tests; browser-download interrupts classified and retried with backoff.
- **2.8.0** — per-file download dedupe, reliable collection-deck mounting after SPA navigation, link-resolution retries with backoff and jitter, stricter sender checks, allowlisted log markup, a once-per-tab notice when a Nexus page change disables a feature; ESLint, jsdom fixture tests and web-ext lint in CI; README ToS disclaimer; locale updates.

## 2026-10-04

**Release 2.7.4**

- Check Nexus pages for the elements the extension relies on and name API changes; clearer skipped-file reasons.
- Merged community PR #11 (game-id support, requirements via `composedPath`, `#action-vortex` detection).

## 2026-09-30

- Skip removed mods, survive a single Cloudflare answer, download smallest files first.

## 2026-09-29

**Release 2.7.3 `[2.7.3]`**

- Ignore Cloudflare's passive bot check.
- README redesigned with an animated SVG hero and source map, then made more compact.

## 2026-09-27

**Release 2.7.2 `[2.7.2]`**

- Read Vortex links on older Chromium versions.

## 2026-09-17

**Release 2.7.1**

- Recognise removed-mod notices.

## 2026-09-14

**Release 2.7.0**

- Fix Wabbajack deck placement; refreshed store listing and app descriptions.

## 2026-09-13

- Release gate, background-worker refactor and tests; one shared download-link parser; page features loaded on demand and the `downloads.ui` permission dropped.

## 2026-09-12

- README SVG updated for 2.6.4.

## 2026-09-11

**Release 2.6.4 `[2.6.4]`**

- Fix duplicate collection downloads in Firefox; development tools removed from the repository.

## 2026-09-07

**Release 2.6.2**

- Fix download validation and history.

## 2026-09-06

**Release 2.6.1**

- Deeper download fallbacks for legacy URLs (issue #3).
- Wabbajack import, error-reporting and UI fixes; review prompt (later milestone-based); activity trail in place of the old debug-logs setting; queue time-left estimate.

## 2026-09-05

- GPL-3.0-or-later licence for `nnw.js`; extension internals and localisation updated.
- Retry logic refined; Wabbajack importer refactored; download-URL parser hardened (scoped to the file ID, separate mod-manager/browser flows, ambiguous matches rejected).
- Background resilience: a dead-man's switch for the reconcile alarm, plus architecture review fixes.

## 2026-08-30

**Release 2.6.0**

- Fix stuck manual downloads and missing Vortex imports in collections; collection queue hardened, accessibility and i18n gaps closed.
- Wabbajack modlist import (beta, off by default): dependency-free `.wabbajack` reader, import from the collection deck, its own info dialog, named skipped archives.
- Skip the Nexus ad timer and map a modlist onto the existing queue.
- README updated for the Wabbajack import and 2.6.0 banner (several SVG cache-bust commits).

## 2026-08-28

**Release 2.5.2 `[2.5.2]`**

- Fix Vortex preflight; redesigned popup and page-settings layout.

## 2026-08-27

**Releases 2.4.5 and 2.5.0 `[v2.5.0]`**

- **2.5.0** — tabbed popup and donation options; refreshed onboarding and popup UX.
- **2.4.5** — Cloudflare fallback and close-tab race fixes.
- SECURITY.md added; install docs point to GitHub Releases and the official store listings.

## 2026-08-24

**Release 2.4.4**

- Repository restructured with a Firefox build; store assets tracked; NexusMods Bypass split out as a standalone repository.

## 2026-08-04 → 2026-08-23

- 2026-08-04 — first commit: NexusMods Bypass imported alongside other extensions.
- 2026-08-10 — **2.4.3**: removed the HideDownloadBar option.
- Until the split on 2026-08-24 this repository also held unrelated extensions; their commits (2026-08-06 → 2026-08-23) did not touch NexusMods Bypass and are not listed.

<img src="docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
