<p align="center">
  <img src="docs/assets/header-changelog.svg" alt="Changelog" width="100%" />
</p>

<p align="center"><sub><a href="README.md">← README</a> · <a href="PRIVACY.md">Privacy</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="CHANGELOG.md">Changelog</a></sub></p>

<img src="docs/assets/divider.svg" alt="" width="100%" />

Every commit on `main`, newest first and grouped by day (152 commits, 2026-08-04 → 2026-10-12).
Each entry links to its commit; sub-bullets come from the commit message and its diff stats. Version bumps
(from `manifest.json`) and Git tags are noted where they happened. Commits for other extensions that shared
the repository before NexusMods Bypass was split out (2026-08-24) are folded into collapsed sections.

## 2026-10-13 — v3.0.1

### Vortex hand-off (feat/vortex-handoff)
- **"Sent to Vortex" history** — Vortex hand-offs are recorded in a separate `vortexSent_<type>` list instead of as downloaded, so they are never skipped forever: the next run sends them again (logged as a re-send). Vortex itself skips files it already has, so a re-send is harmless. Redownload and a clean finish clear both lists.
- **First hand-off is confirmed** — after the first file, the run waits for the page to lose focus or go hidden (the OS opening Vortex). If that does not happen within 4 s, it asks once, "Did Vortex open?"; "No, stop" ends the run instead of sending the rest into the void. Pacing between files is unchanged.
- **Expired links are not sent** — the `expires` time of an nxm:// link is checked (with a 30 s margin) before the hand-off; an expired link is logged ("Link expired, fetching a new one") and fetched again once.
- **Account check** — the Nexus account a link is signed for (`user_id`) is named once per run, with a reminder that Vortex must be signed into the same account. When the page shows a different signed-in member id, a warning appears instead.
- **Clearer end-of-run message** — explains that sent files are kept as "sent", so running again only fetches what Vortex is missing.
- **Collection guidance** — the Vortex prompt and the run log recommend starting a whole collection in Vortex ("Download collection in Vortex") and using the extension to send the files Vortex asks for.

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

- [`4d19f8c`](https://github.com/thomasthanos/nexusmods-bypass/commit/4d19f8c1737c7559c8731ab0d97c732410a227be) feat(diagnostics): severity embeds, embed limits, auto-error dedupe, page field, labelled GitHub issues
  - 5 files (+128 / −15): `tools/`, `CHANGELOG.md`, `relay/`, `src/report.js`
- [`53fac74`](https://github.com/thomasthanos/nexusmods-bypass/commit/53fac74aeac309416f22d992832ddceab3a7bb01) feat(ui): themed scrollbars, accessible custom selects, focus/hover states, reduced motion; report-page Playwright check
  - 5 files (+190 / −2): `src/content/`, `CHANGELOG.md`, `src/popup/`, `tests/`
- [`9cbf697`](https://github.com/thomasthanos/nexusmods-bypass/commit/9cbf697cc80d8af231ff19f0ef3f75f16d0f0d10) feat: confirm before downloading more than 50 mods
  - 14 files (+196 / −3): `src/content/`, `locales`
- [`8a94099`](https://github.com/thomasthanos/nexusmods-bypass/commit/8a94099c0f5c1d75a7394c3a4c10f267c346535c) P2/P3 UI: new-revision and update badges, click-only endorse/track, archive identification by MD5; locales; Playwright
  - 18 files (+1173 / −5): `src/content/`, `tests/`, `locales`
- [`0a07f6c`](https://github.com/thomasthanos/nexusmods-bypass/commit/0a07f6c284233354739cdf612a4705c372a406b5) Add Playwright layout tests at 4 viewports x 3 zoom levels; release 2.8.1 — version → **2.8.1**
  - tests/visual/layout.spec.mjs loads the unpacked extension in Chromium against local fixtures (collection API canned) and asserts no horizontal overflow and that the FAB, settings modal, collection deck, mod picker, page-change not…
  - 11 files (+283 / −9): `tools/`, `.github/`, `.gitignore`, `CHANGELOG.md`
- [`11cbeb9`](https://github.com/thomasthanos/nexusmods-bypass/commit/11cbeb97774aee782a54e898f86e12313a85774f) Add package.json dev tooling, ESLint, jsdom fixture tests and web-ext lint in CI
  - package.json (dev-only: jsdom, eslint, web-ext) with test/lint scripts. - eslint.config.mjs focused on real mistakes; the codebase lints clean.
  - 13 files (+5068 / −3): `tools/`, `.github/`, `.gitignore`, `eslint.config.mjs`

### Changed

- [`b74e5f0`](https://github.com/thomasthanos/nexusmods-bypass/commit/b74e5f009f0d1faa5aa7545daddfcd6905f0c3ce) chore: prepare 3.0.0 major release with complete 47-commit history — version → **3.0.0**, tagged `3.0.0`
  - 9 files (+175 / −29): `.github/`, `internal/`, `CHANGELOG.md`, `README.md`
- [`d300b5e`](https://github.com/thomasthanos/nexusmods-bypass/commit/d300b5e94b5b7bf36b6c8e7b02ca3d0846fb7749) Debug log page: live view, level filter, search, clear, export (#18) ([#18](https://github.com/thomasthanos/nexusmods-bypass/pull/18))
  - feat(debug): debug log page with live view, level filter, search, clear and export; PRIVACY relay host fix
  - fix(i18n): keep original locale file formatting (line endings) when adding debug keys
  - 25 files (+976 / −27): `src/debug-page/`, `tools/`, `src/popup/`, `CHANGELOG.md`, `locales`
- [`6a5654f`](https://github.com/thomasthanos/nexusmods-bypass/commit/6a5654f3b07a824e49bfca09a5f953b34ec70a4a) Complete diagnostics rollout with shared page paths and relay KV
  - Use one redacted Nexus page-path helper in manual and automatic reports. Bind the deployed relay to shared KV rate-limit and dedupe storage and document the rollout.
  - 6 files (+26 / −24): `relay/`, `CHANGELOG.md`, `src/background.js`, `src/report.js`
- [`ea3599f`](https://github.com/thomasthanos/nexusmods-bypass/commit/ea3599fbd3d676e518fcfe5b934da86104492f03) Redesign report flow and relay payloads
  - This change upgrades the manual report UI into a responsive workspace with summary/category fields, reproduction details, validation, inline guidance, send protection, and a reviewed JSON preview.
  - On the relay side, Discord reports now include a JSON attachment alongside the summary, and the GitHub fallback preserves the human description while excluding the reply e-mail.
  - 23 files (+1964 / −117): `src/report-page/`, `relay/`, `tools/`, `CHANGELOG.md`, `locales`
- [`ed27cb9`](https://github.com/thomasthanos/nexusmods-bypass/commit/ed27cb91b4cce4577765a8a831b66c4e7a3309bc) Enable deployed Cloudflare report relay
  - Point optional relay access at the deployed mariosthanos3 Worker and enable report sending after live health and Discord delivery verification. Document the deployment and keep package permission checks in sync.
  - 5 files (+18 / −9): `README.md`, `relay/`, `src/manifest.json`, `src/shared.js`
- [`cba1537`](https://github.com/thomasthanos/nexusmods-bypass/commit/cba153725c6c86b6700a42b9a70d69f9c383c64e) chore: 2.10.2 — version → **2.10.2**
  - 4 files (+32 / −4): `CHANGELOG.md`, `package-lock.json`, `package.json`, `src/manifest.json`
- [`287f280`](https://github.com/thomasthanos/nexusmods-bypass/commit/287f280b6ef3e420f74e6f9f9ba428e78a17bd39) chore(release): publish 2.10.1 ([#14](https://github.com/thomasthanos/nexusmods-bypass/pull/14)) — tagged `2.10.1`
  - Merge pull request #14: official Nexus API and reliability fixes
  - Publish the Chrome/Edge and Firefox packages after regression, lint, Chromium layout and live-schema checks.
  - 39 files (+2556 / −24): `src/content/`, `tools/`, `.github/`, `CHANGELOG.md`, `locales`
- [`6bb627e`](https://github.com/thomasthanos/nexusmods-bypass/commit/6bb627e0b8f81ed69ad862ec5f770c0b02125b34) P1/P2: collections, revisions, game id and file list via official API with legacy fallback; batched details; update policy — version → **2.10.0**
  - 5 files (+217 / −9): `src/content/`, `src/manifest.json`, `src/shared.js`
- [`a9b5097`](https://github.com/thomasthanos/nexusmods-bypass/commit/a9b5097eb44bdee915e472f50ffe64c6315d5ccc) Phase 0: official Nexus API module (throttle, 429 backoff, caching), schema watch CI, tests
  - 8 files (+889 / −4): `tools/`, `.github/`, `package-lock.json`, `package.json`
- [`9ce3474`](https://github.com/thomasthanos/nexusmods-bypass/commit/9ce3474abef41b610351ceae923d612c1c484256) CI: manifest-watch permission diff with PR comment and Discord summary; optional Discord notify for releases and bug issues
  - 4 files (+214 / −0): `.github/`, `tools/`
- [`b2a9d3f`](https://github.com/thomasthanos/nexusmods-bypass/commit/b2a9d3fc91c4e995be5ffb1b751e3e905f94f4e7) Opt-in report system: redaction, debug ring buffer, report page with preview, relay send
  - Extends the existing report builder (report.js) and Help tab instead of adding a parallel system: - shared.js: redactPersonalData (e-mails, home paths, Nexus profile names, cookies, bearer/JWT, long tokens) is now part of sanitize…
  - 38 files (+1684 / −21): `tools/`, `relay/`, `src/content/`, `src/report-page/`, `locales`
- [`5e60003`](https://github.com/thomasthanos/nexusmods-bypass/commit/5e6000332425c9f271b0b254d776819168242a1f) Responsive layer for all injected UI (720p..4K, zoom 100-150%)
  - clamp()-based fluid sizing and gutters, viewport-bounded max-widths, modals capped to 100dvh with internal scrolling, wrapping headers/footers/button rows, 40px touch targets, viewport-relative list heights, narrow-viewport FAB th…
  - 3 files (+91 / −0): `src/content/`, `src/onboarding/`, `src/popup/`
- [`5ac7d97`](https://github.com/thomasthanos/nexusmods-bypass/commit/5ac7d976871dde0c1ab30a7d62da0db1c2f6feca) Classify browser-download interrupts and retry with backoff
  - NXTK.classifyDownloadInterrupt maps chrome.downloads interrupt reasons to transient (2 retries), expired/refused link (1 retry with a fresh link), size check (1), unknown (1, as before), and disk/blocked/user (no retry).
  - 3 files (+49 / −1): `src/background.js`, `src/shared.js`, `tools/`
- [`0ef75e2`](https://github.com/thomasthanos/nexusmods-bypass/commit/0ef75e2275f6481d55b041108fa9d80e7b7e05c9) Translate the updated pause-between-mods description into all locales
  - 12 files (+12 / −12): `locales`
- [`e4b2c17`](https://github.com/thomasthanos/nexusmods-bypass/commit/e4b2c17747a3983b4ad67bd4738ad48a1b9b4e7d) Translate the page-change notice strings into all 13 locales
  - 13 files (+117 / −0): `locales`
- [`0886430`](https://github.com/thomasthanos/nexusmods-bypass/commit/088643091b3a7de1e7d85d439620941e922eed22) Tell the user once per tab when a Nexus page change disables a feature
  - When the page check finds the download control or the collection deck spot missing, a dismissible notice explains that Nexus changed the page, that Nexus's own buttons still work, and how to report it. Adds UI.showNotice.
  - 2 files (+51 / −0): `src/content/`
- [`b777774`](https://github.com/thomasthanos/nexusmods-bypass/commit/b777774de13acf8f7a52e68a81375171bb77c619) Render log markup through an allowlist instead of raw innerHTML
  - NXTK.setSafeHtml parses markup inertly and rebuilds only a, span, strong, b, em, i, code, br and small with class/title/target/rel and http(s) href; everything else becomes text.
  - 2 files (+39 / −1): `src/content/`, `src/shared.js`
- [`855e88f`](https://github.com/thomasthanos/nexusmods-bypass/commit/855e88f0f73a1881d01cdb2f5c25d866ac758f2b) Tighten isTrustedSender: a sender with no URL is accepted only outside a tab
  - Content scripts always report their page URL; a tab-attached sender without one is now refused. Adds unit tests for the sender policy.
  - 2 files (+14 / −3): `src/background.js`, `tools/`
- [`dc46125`](https://github.com/thomasthanos/nexusmods-bypass/commit/dc46125993f20e1fe13348023e7d53056185d3d0) Retry link resolution with exponential backoff and jitter; keep a minimum hand-off gap
  - NXTK.retryDelayMs (equal-jitter exponential backoff) replaces the fixed 1.5s retry; link resolution now gets 3 attempts (1.5s..15s).
  - 6 files (+46 / −14): `src/content/`, `src/background.js`, `src/shared.js`, `tools/`, `locales`
- [`d21a19c`](https://github.com/thomasthanos/nexusmods-bypass/commit/d21a19cab9bb8c1f6188dc0751a1c799f15a914e) Mount the collection deck reliably after SPA navigation and late hydration
  - ensureControlDeckMounted gave up silently when the deck spot was not in the DOM yet, so the deck appeared only after a reload.
  - 1 file (+43 / −4): `src/content/`

### Fixed

- [`4af0278`](https://github.com/thomasthanos/nexusmods-bypass/commit/4af0278de686babb098bd3866b35de2519a83da9) fix(report): request relay permission synchronously in the click; debug-page toggle; 2.10.3 (#19) ([#19](https://github.com/thomasthanos/nexusmods-bypass/pull/19)) — version → **2.10.3**
  - 22 files (+167 / −17): `src/debug-page/`, `CHANGELOG.md`, `package-lock.json`, `package.json`, `locales`
- [`5782735`](https://github.com/thomasthanos/nexusmods-bypass/commit/578273501927f9c8a451983fe0557698131eae80) Fix popup sizing and test compatibility
  - Chromium can collapse browser-action popups when a viewport-relative width cap is applied during measurement, so the popup root now keeps its declared panel width while allowing wrapping.
  - 4 files (+43 / −5): `tools/`, `src/popup/`, `tests/`
- [`a87b830`](https://github.com/thomasthanos/nexusmods-bypass/commit/a87b830f9229d9c07c9e5cf4ee23b0bfc6a9305b) feat(report): relay health check, specific errors, retry, GitHub fallback, relay build flag; relay fixes
  - 25 files (+836 / −74): `tools/`, `src/report-page/`, `relay/`, `src/background.js`, `locales`
- [`4df0bab`](https://github.com/thomasthanos/nexusmods-bypass/commit/4df0bab21aff04d556917ef9288919c58e63b2e4) fix: quiet API attempt errors, session-checked login errors, page-check variants
  - 5 files (+597 / −432): `src/content/`, `tools/`
- [`ed40f44`](https://github.com/thomasthanos/nexusmods-bypass/commit/ed40f44a83c49c6520fe5c3862b0ad994d96c234) fix: one owner per download click; pin modal to clicked file; background dedupe
  - 4 files (+325 / −43): `tools/`, `src/background.js`, `src/content/`
- [`8cb94a8`](https://github.com/thomasthanos/nexusmods-bypass/commit/8cb94a871ff918cf6220f373dc7b89949f743db1) Dedupe downloads per file_id and stop double-binding the slow-download button
  - A re-rendered download card could lose its data-nxtk-slow-bound marker and get a second click listener, and an automatic start could race a manual click; both started the same browser download twice.
  - Adds src/selectors.js, a central selector/text registry with ordered fallbacks and non-English slow-download labels;
  - 5 files (+212 / −17): `src/content/`, `src/manifest.json`, `src/selectors.js`

### Docs

- [`80ebbd7`](https://github.com/thomasthanos/nexusmods-bypass/commit/80ebbd71f7d7d0af16c87f6b1a27249994e21abf) Update README.md
  - 1 file (+0 / −7): `README.md`
- [`80f60ee`](https://github.com/thomasthanos/nexusmods-bypass/commit/80f60ee68fa23c4426ce03427dd5b23b2b94614c) docs(readme): SVG pill links under Download, richer details summaries
  - 7 files (+44 / −8): `docs/`, `README.md`
- [`fbdfa2a`](https://github.com/thomasthanos/nexusmods-bypass/commit/fbdfa2a26ad66eab4ad21adc68a38721fd7521bc) docs: restyle README and all Markdown docs in the MYLE style (#21) ([#21](https://github.com/thomasthanos/nexusmods-bypass/pull/21))
  - docs: restyle README and all Markdown docs in the MYLE style with shared SVG assets
  - docs: leaner README header and text, text-link nav in docs, CHANGELOG rewritten by date from the full history
  - 24 files (+546 / −1254): `docs/`, `CHANGELOG.md`, `CONTRIBUTING.md`, `PRIVACY.md`
- [`9224b37`](https://github.com/thomasthanos/nexusmods-bypass/commit/9224b37330339dfde6b5b3e61b987b9f5d94bb66) revert: restore README before redesign and remove its SVG assets
  - 84 files (+96 / −1966): `.github/`, `README.md`
- [`3908a05`](https://github.com/thomasthanos/nexusmods-bypass/commit/3908a059ae07d9a08f0f200afcd817a4f0388794) docs: compact README visuals and group licences and support links
  - 1 file (+18 / −19): `README.md`
- [`3f1fa85`](https://github.com/thomasthanos/nexusmods-bypass/commit/3f1fa859de9cf1de8a87bda852ef67580cfb0cf8) docs: add animated glass README and expose both licence scopes and support links
  - 65 files (+1487 / −16): `.github/`, `README.md`
- [`84bb5d7`](https://github.com/thomasthanos/nexusmods-bypass/commit/84bb5d7a042d5c23f200bb20e086db7e845dcbab) docs: add animated SVG README navigation, release cards and footer
  - 20 files (+331 / −9): `.github/`, `README.md`
- [`7711b6c`](https://github.com/thomasthanos/nexusmods-bypass/commit/7711b6c0abf5a72afa474631eb957f46a92cc8d9) docs: redesign README for 3.0.0 with clear installation and support guides
  - 1 file (+177 / −99): `README.md`
- [`92bd618`](https://github.com/thomasthanos/nexusmods-bypass/commit/92bd618f2a0b38bc287d907ee47e31740a7a8b26) docs: polish 3.0.0 release with SVG banner and collapsible sections
  - 2 files (+110 / −7): `.github/`, `internal/`
- [`b5906a9`](https://github.com/thomasthanos/nexusmods-bypass/commit/b5906a95b7a996caa052df7eecd68bd07fafb3dc) Fix API fallback limits and stale viewer cache; prepare 2.10.1 release — version → **2.10.1**
  - Count router requests in the shared limiter and honour router 429s. Share cache initialization, invalidate viewer state after successful actions, preserve unknown update policies, and distinguish failed file lookups from empty lis…
  - 11 files (+270 / −31): `.github/`, `src/content/`, `tools/`, `CHANGELOG.md`
- [`04ad47a`](https://github.com/thomasthanos/nexusmods-bypass/commit/04ad47aa1bf81a06be08dd232c10bce769d2fc1c) Release 2.10.0: changelog, docs status, README and privacy
  - 4 files (+33 / −1): `CHANGELOG.md`, `PRIVACY.md`, `README.md`, `docs/`
- [`91bdeee`](https://github.com/thomasthanos/nexusmods-bypass/commit/91bdeee21bad806495d94d978915ac44a71c2a6c) docs: Nexus site map and official API study with migration plan
  - 1 file (+205 / −0): `docs/`
- [`b39bb18`](https://github.com/thomasthanos/nexusmods-bypass/commit/b39bb18974c5d9fcca38f824b0f5b2b171ccbb05) Release 2.9.0: version bump, changelog, privacy and README for reports and relay — version → **2.9.0**
  - 8 files (+31 / −10): `tools/`, `CHANGELOG.md`, `PRIVACY.md`, `README.md`
- [`90a8939`](https://github.com/thomasthanos/nexusmods-bypass/commit/90a89399fea4b6151925fcac1078e1cf9dbcfc6e) README: drop unverified ToS link
  - 1 file (+1 / −1): `README.md`
- [`3b98b1e`](https://github.com/thomasthanos/nexusmods-bypass/commit/3b98b1e5ab37bbb15f6712e0dee62cb331605213) Release 2.8.0: changelog, version bump and README ToS disclaimer — version → **2.8.0**
  - 3 files (+44 / −1): `CHANGELOG.md`, `README.md`, `src/manifest.json`

### Merged

- [`0de791a`](https://github.com/thomasthanos/nexusmods-bypass/commit/0de791a95e99fd84c8ca2318342abadce9a68543) Merge pull request #16 from thomasthanos/fix/live-test-2.10.1 ([#16](https://github.com/thomasthanos/nexusmods-bypass/pull/16))
  - 2.10.2: live-test fixes (duplicate downloads, false errors), large-run confirm, report sending, UI polish
  - 40 files (+2176 / −558): `tools/`, `src/content/`, `src/report-page/`, `relay/`, `locales`
- [`e808141`](https://github.com/thomasthanos/nexusmods-bypass/commit/e808141a8c8cf337517817be30af461ef9130556) Merge pull request #13: robustness, responsive UI and diagnostics ([#13](https://github.com/thomasthanos/nexusmods-bypass/pull/13)) — version → **2.9.0**
  - Robustness fixes and review follow-ups (2.8.0)
  - 68 files (+8187 / −80): `tools/`, `src/content/`, `relay/`, `.github/`, `locales`

## 2026-10-04

**Versions / tags:** **2.7.4**

### Changed

- [`c6e7563`](https://github.com/thomasthanos/nexusmods-bypass/commit/c6e75638b443d13bd45b4e74cb21cca0e3e24680) Release 2.7.4 — version → **2.7.4**
  - Smallest files first, removed mods skipped without stopping the run, a lone Cloudflare answer skipped, and the Nexus page and API check. Bump to 2.7.4: manifest, changelog, banner and spec badges, store notes.
  - 5 files (+10 / −8): `.github/`, `CHANGELOG.md`, `internal/`, `src/manifest.json`
- [`7f29314`](https://github.com/thomasthanos/nexusmods-bypass/commit/7f293148a3fa924046bcfdb6c6e22b146ae2ce55) Name a skipped file's reason without the error advice
  - Run end to end in Chromium, a skipped mod logged as "Skipped: Medium (This mod has been hidden or removed. The mod is no longer available on Nexus Mods.
  - 2 files (+9 / −5): `src/content/`, `tools/`
- [`672e030`](https://github.com/thomasthanos/nexusmods-bypass/commit/672e030a0794fc3f5144b5af864acd0c6094fbd2) Check Nexus pages for what the extension relies on, and name API changes
  - A Nexus redesign showed only as a feature quietly doing nothing: the deck not mounting when findCollectionHost found no spot, the game id coming back empty, a file page with no download control.
  - content/page-check.js runs on mod, file and collection pages after the page settles, and again before calling anything missing.
  - 25 files (+750 / −8): `src/content/`, `tools/`, `CHANGELOG.md`, `src/manifest.json`, `locales`

### Merged

- [`80c9beb`](https://github.com/thomasthanos/nexusmods-bypass/commit/80c9beba6f5f9a986f1c8e254818f443e6afb631) Merge pull request #11 from torkelicious/main ([#11](https://github.com/thomasthanos/nexusmods-bypass/pull/11))
  - improvements to how game IDs are detected and how requirements tab links are intercepted
  - 1 file (+63 / −38): `src/content/`

## 2026-09-30

### Added

- [`843ea8c`](https://github.com/thomasthanos/nexusmods-bypass/commit/843ea8c6a1d21553774b4e5dd0362226bb071573) [game-id] support
  - both [data-game-id] and [game-id] are valid depending on context, they must both be scanned for
  - 1 file (+50 / −30): `src/content/`

### Changed

- [`20bcdcf`](https://github.com/thomasthanos/nexusmods-bypass/commit/20bcdcfaeabb78b9459e0917f6ae757ecee4f256) #action-vortex detetction
  - 1 file (+1 / −1): `src/content/`
- [`11b207b`](https://github.com/thomasthanos/nexusmods-bypass/commit/11b207b70ce0f6bb792c84c41b05c67a6e35f0b3) requirements via composedpath
  - works better through shadow dom , and will ignore already handled events.
  - 1 file (+12 / −7): `src/content/`

### Fixed

- [`95e5351`](https://github.com/thomasthanos/nexusmods-bypass/commit/95e5351cb9370e090c55860f2a719f6b7ef63abe) Skip removed mods, survive a lone Cloudflare answer, download smallest first
  - A collection run treated a single Cloudflare answer as a site-wide block and stopped, and a removed mod got a pointless second attempt and was reported as a failure.
  - shared.js holds the queue policy both queues use: queueSkipReason names a gone mod (mod_unavailable, file_not_found, moderation_hold) as a skip, and a Cloudflare answer as one while fewer than CLOUDFLARE_SKIP_LIMIT (3) came in a r…
  - 21 files (+974 / −13): `src/content/`, `tools/`, `CHANGELOG.md`, `README.md`, `locales`

## 2026-09-29

**Versions / tags:** tag `2.7.3` · **2.7.3**

### Fixed

- [`645aa92`](https://github.com/thomasthanos/nexusmods-bypass/commit/645aa9201a8dcf125c98ee6285825cc23bfe1612) Ignore Cloudflare's passive bot check and release 2.7.3 — version → **2.7.3**
  - Cloudflare adds /cdn-cgi/challenge-platform/scripts/jsd/main.js to ordinary pages as a passive bot check.
  - response-classifier.js only takes a challenge's own challenge-platform/h/&lt;v&gt;/orchestrate/ path as a marker; the Cf-Mitigated header, _cf_chl_opt and the other markers are unchanged.
  - 10 files (+56 / −13): `.github/`, `tools/`, `CHANGELOG.md`, `README.md`

### Docs

- [`03d6b49`](https://github.com/thomasthanos/nexusmods-bypass/commit/03d6b490815745bb4d6a72ad2ddd09554b79835a) Make README and animated SVGs more compact — tagged `2.7.3`
  - 4 files (+168 / −314): `.github/`, `README.md`
- [`0b036b3`](https://github.com/thomasthanos/nexusmods-bypass/commit/0b036b3d04f83f67001862ee1ea9b58dae813131) Redesign README with animated SVG hero and source map
  - 5 files (+463 / −344): `.github/`, `README.md`

## 2026-09-27

**Versions / tags:** tag `2.7.2` · **2.7.2**

### Changed

- [`1bd1a22`](https://github.com/thomasthanos/nexusmods-bypass/commit/1bd1a222e583d110038ea513a63ee7ad5810f1bf) Read Vortex links on older Chromium and release 2.7.2 — version → **2.7.2**, tagged `2.7.2`
  - Chromium before 130 parsed a URL of a scheme it did not know as an opaque path: nxm://game/mods/1/files/2 had an empty hostname and the pathname //game/mods/1/files/2.
  - download-url-parser.js splits an nxm:// link by hand instead of through URL. The authority must be a bare game domain, which also rules out credentials and a port; the path, key, expiry and user checks are unchanged.
  - 25 files (+163 / −45): `tools/`, `.github/`, `CHANGELOG.md`, `README.md`, `locales`

## 2026-09-17

**Versions / tags:** **2.7.1**

### Fixed

- [`a9e104a`](https://github.com/thomasthanos/nexusmods-bypass/commit/a9e104a80a7dc757c6937cad135128d660ca547c) Recognise removed-mod notices and release 2.7.1 — version → **2.7.1**
  - Nexus serves a removed, hidden, unpublished or missing mod as a single site notice where the mod page was.
  - response-classifier.js reads the notice title from its markup (Removed by author, Removed by staff, Hidden mod, Not published, Not found) and returns mod_unavailable.
  - 25 files (+260 / −31): `tools/`, `.github/`, `src/content/`, `CHANGELOG.md`, `locales`

## 2026-09-14

**Versions / tags:** **2.7.0**

### Fixed

- [`8f4ee29`](https://github.com/thomasthanos/nexusmods-bypass/commit/8f4ee29ddc9009d4d2bed2c7e8149cb7ce6d63af) Fix Wabbajack deck placement and release 2.7.0 — version → **2.7.0**
  - This release fixes imported Wabbajack modlists replacing a collection deck and leaving the page in a broken state by mounting the deck once, restoring the collection deck correctly on close, and keeping it in the content column wh…
  - 12 files (+132 / −40): `src/content/`, `.github/`, `tools/`, `CHANGELOG.md`

### Docs

- [`6829a96`](https://github.com/thomasthanos/nexusmods-bypass/commit/6829a96cbf6e33cadb3def4db2eb80f44062e913) Refresh store listing and app descriptions
  - This update aligns the extension copy with the current download workflow: auto-starting Nexus Mods downloads, queueing full collections to Vortex or the browser, and skipping files already present.
  - 15 files (+26 / −44): `.gitignore`, `internal/`, `locales`

## 2026-09-13

### Added

- [`0ba1fcd`](https://github.com/thomasthanos/nexusmods-bypass/commit/0ba1fcd9790a1d8c5816c1989c63cd7d42eb129e) Add release gate, worker refactor & tests
  - Add CI release-gate workflow and a build script; centralise shared logic and tighten worker/page interactions.
  - 27 files (+898 / −1024): `src/content/`, `src/popup/`, `.github/`, `.gitignore`, `locales`

### Changed

- [`b783a49`](https://github.com/thomasthanos/nexusmods-bypass/commit/b783a49d9c04ee12b9978c79cafd6a8aace1a9fd) Load page features on demand and drop downloads.ui
  - The collection deck, settings dialog, Wabbajack importer and bug report builder are bundles the worker injects with chrome.scripting when a page first needs them, so every Nexus page loads 174 KB of script instead of 368 KB.
  - 20 files (+3249 / −2724): `src/content/`, `tools/`, `CHANGELOG.md`, `PRIVACY.md`
- [`0387ab5`](https://github.com/thomasthanos/nexusmods-bypass/commit/0387ab55d10012f13a89520130980bd3ce44bce4) Share one download-link parser and track the release tools
  - Move link parsing out of nnw.js into src/download-url-parser.js, original code under the main licence, loaded by the content scripts and the worker.
  - 23 files (+5635 / −340): `tools/`, `src/content/`, `.gitignore`, `CHANGELOG.md`

## 2026-09-12

### Docs

- [`d90fc03`](https://github.com/thomasthanos/nexusmods-bypass/commit/d90fc0380e1f44be002a47875de285977abe57dc) Update README SVG version to 2.6.4
  - 3 files (+3 / −3): `.github/`, `README.md`

## 2026-09-11

**Versions / tags:** tag `2.6.4` · **2.6.4**

### Changed

- [`642ffe5`](https://github.com/thomasthanos/nexusmods-bypass/commit/642ffe59170dcacb8e8d491ed15390418466ef39) Remove development tools from repository — tagged `2.6.4`
  - Keep the local test and packaging utilities ignored while removing them from the published source tree.
  - 9 files (+2 / −4939): `tools/`, `.gitignore`

### Fixed

- [`c9b869e`](https://github.com/thomasthanos/nexusmods-bypass/commit/c9b869e6921111bc0e13a15e9d74a7246117b3db) Fix Firefox duplicate collection downloads — version → **2.6.4**
  - Serialize terminal download handling, retire exact browser download IDs before retrying, and guard queue state transitions against Stop/Restart races.
  - 30 files (+6481 / −253): `tools/`, `src/content/`, `.gitignore`, `CHANGELOG.md`, `locales`

## 2026-09-07

**Versions / tags:** **2.6.2**

### Fixed

- [`cc1f469`](https://github.com/thomasthanos/nexusmods-bypass/commit/cc1f46951f525b1c7f5a48324eac997caa00108d) Fix download validation and history — version → **2.6.2**
  - This release fixes several NDC download issues: transfers are validated against the server Content-Length instead of Nexus's often-wrong listing, selected downloads and collection updates now record history so Skip Downloaded stop…
  - 6 files (+122 / −34): `.github/`, `CHANGELOG.md`, `README.md`, `src/background.js`

## 2026-09-06

**Versions / tags:** **2.6.1**

### Added

- [`dabba8b`](https://github.com/thomasthanos/nexusmods-bypass/commit/dabba8bee3228d86c76b030262fceb15cffd539a) Add queue ETA, improve Wabbajack import & rating
  - Measure and show a remaining-time ETA for queue runs (measured from finished files). Add UI/CSS for ETA and a decorated rating prompt; rating link now chosen by extension listing id (getStoreListing) rather than user agent.
  - 24 files (+536 / −45): `src/content/`, `src/popup/`, `CHANGELOG.md`, `README.md`, `locales`
- [`b29a797`](https://github.com/thomasthanos/nexusmods-bypass/commit/b29a797647e30e2b74d5d5a6888000d94863a043) Remove DebugLogs setting and add activity trail
  - Remove the DebugLogs UI option and its translations, and replace noisy verbose logging with a small recorded activity trail included in bug reports.
  - 17 files (+81 / −107): `src/content/`, `CHANGELOG.md`, `src/shared.js`, `locales`
- [`d7c776f`](https://github.com/thomasthanos/nexusmods-bypass/commit/d7c776f19ff0f5f422c2c1b7771ad66ec4bec43b) Add review prompt, improve NDC handling & UI
  - Introduce a one‑time review prompt in the deck (shown after ≥5 finished files) with store‑specific review URLs and storage helpers (wasRatingPrompted/markRatingPrompted). Update onboarding, popup and many locale strings;
  - 26 files (+712 / −354): `src/content/`, `src/onboarding/`, `.github/`, `CHANGELOG.md`, `locales`

### Changed

- [`a3e0baf`](https://github.com/thomasthanos/nexusmods-bypass/commit/a3e0baf9ece0754b60219164f36957b79ec5748f) Make rating prompts milestone-based
  - Replace the old one-time rating prompt with a milestone-driven flow. Add persistent rating state (RATING_STATE_KEY) and milestones ([25,120,500,1500]) with a 21-day gap.
  - 22 files (+351 / −192): `src/content/`, `src/popup/`, `CHANGELOG.md`, `README.md`, `locales`
- [`6ae045c`](https://github.com/thomasthanos/nexusmods-bypass/commit/6ae045cdbd960e1fdac37bfede871c2a9a4c8599) patch
  - 2 files (+18 / −0): `CHANGELOG.md`, `src/content/`

### Fixed

- [`2f2c7e0`](https://github.com/thomasthanos/nexusmods-bypass/commit/2f2c7e0c897d35d4b60cfbf080a771b7291849bf) Wabbajack import, error-reporting and UI fixes
  - Enhance Wabbajack import, diagnostics and UI behavior.
  - Key changes: - Wabbajack importer: parse only the Archives array (much lower memory), raised modlist limit to 256MiB, added archive-size safeguards and downloader labels; improved error handling.
  - 24 files (+1087 / −178): `src/content/`, `.github/`, `CHANGELOG.md`, `README.md`, `locales`
- [`4bb95ac`](https://github.com/thomasthanos/nexusmods-bypass/commit/4bb95ac99826c56d9bfc805d11caea632644dad8) Deeper Download Fallbacks for Legacy URLs (fix for issue #3)
  - 1 file (+69 / −12): `src/content/`

### Docs

- [`4c3cdd2`](https://github.com/thomasthanos/nexusmods-bypass/commit/4c3cdd254f435429c99d379c9f84853d88d47435) Release 2.6.1 — update manifest, docs & privacy — version → **2.6.1**
  - Bump extension version to 2.6.1 and mark the release in CHANGELOG. Clarify ad-timer cookie behavior and collection-run requirements, add a short in-memory action list and expand the bug-reporter description in PRIVACY.md.
  - 5 files (+42 / −22): `CHANGELOG.md`, `PRIVACY.md`, `README.md`, `internal/`
- [`5279ed1`](https://github.com/thomasthanos/nexusmods-bypass/commit/5279ed17fcd40314f4d98472bd88e75ecee787d4) Refresh contributors cache

## 2026-09-05

### Added

- [`560c8bf`](https://github.com/thomasthanos/nexusmods-bypass/commit/560c8bf09454348c4050d4408e16e3b165b9a75f) Implement DeepSeek architectural review recommendations
  - 1. Add 5-minute periodic reconcile alarm to resume stuck jobs
  - 2. Add memory cleanup for stale pending terminal downloads (1 hour TTL)
  - 2 files (+19 / −3): `src/background.js`, `src/content/`

### Changed

- [`de10710`](https://github.com/thomasthanos/nexusmods-bypass/commit/de10710ac64a89a1fc3094f2d242943a39048a37) Optimize background resilience: implement dead-man's switch for reconcile alarm
  - This eliminates idle CPU usage. The 5-minute alarm is now pushed forward dynamically during active downloads. If the queue is completely idle, the alarm is completely cleared.
  - 1 file (+20 / −3): `src/background.js`
- [`4420858`](https://github.com/thomasthanos/nexusmods-bypass/commit/4420858ae0cd6ba3996188a434f03be959f83287) Harden download URL parser: scope to fileId, segregate NMM/browser flows, reject ambiguous matches
  - The download-URL parser now threads the requested fileId through every extraction
  - strategy (JSON traversal, embedded attributes, bare CDN scanning) so that multi-file
  - 3 files (+289 / −130): `src/content/`, `CHANGELOG.md`
- [`e332ef4`](https://github.com/thomasthanos/nexusmods-bypass/commit/e332ef402152b262b062af360ea1434c20c60b6e) Refactor Wabbajack modlist importing
  - 8 files (+610 / −351): `src/content/`, `CHANGELOG.md`, `src/background.js`, `src/manifest.json`
- [`d65eb5f`](https://github.com/thomasthanos/nexusmods-bypass/commit/d65eb5f987b5d1272a8def25cffc03374acb51c7) notes
  - 9 files (+17 / −2): `src/content/`, `src/background.js`, `src/shared.js`
- [`0bbe1d2`](https://github.com/thomasthanos/nexusmods-bypass/commit/0bbe1d29e74840ccf198bcbde6bc392c8fcd64c1) Refine retry logic and remove debug clutter
  - This change removes a large amount of explanatory inline comments that were no longer useful, while keeping the actual behavior intact.
  - 15 files (+3 / −256): `src/content/`, `src/popup/`, `src/onboarding/`, `.gitignore`
- [`83187e0`](https://github.com/thomasthanos/nexusmods-bypass/commit/83187e0e152f65e1c24f8d4d063f69b92745f14f) patch
  - 6 files (+3 / −998): `tools/`, `.gitignore`
- [`d096a6a`](https://github.com/thomasthanos/nexusmods-bypass/commit/d096a6a1b5e8aa800f2511de79da76f79ad99582) Updated Extension Internals and Localization
  - ## Changelog
  - ### Localization - Updated translations across multiple languages (de, el, en, es, fr, it, ja, ko, pl, pt_BR, ru, tr, zh_CN) to improve accuracy and add missing strings.
  - 16 files (+15990 / −15980): `src/content/`, `src/background.js`, `locales`

### Docs

- [`613d655`](https://github.com/thomasthanos/nexusmods-bypass/commit/613d655b510eabfa82293a1e64755765f8e5ee61) Refresh repository cache
- [`c70fe33`](https://github.com/thomasthanos/nexusmods-bypass/commit/c70fe3362d8ff03a455a8015c5ad86cd0671a90f) Add GPL-3.0-or-later license for nnw.js
  - Mark src/content/nnw.js as GPL-3.0-or-later and include the full GPLv3 text (src/LICENSE-GPL-3.0-or-later.txt). Update nnw.js header with SPDX and upstream attribution (Nexus No Wait ++).
  - 7 files (+742 / −19): `CONTRIBUTING.md`, `LICENSE`, `README.md`, `THIRD-PARTY-NOTICES.md`

## 2026-08-30

**Versions / tags:** **2.6.0**

### Added

- [`e5adc37`](https://github.com/thomasthanos/nexusmods-bypass/commit/e5adc3708833909dfc3f1144251635d9dc80d313) Give the Wabbajack import its own info dialog
  - Matches the info button that already sits beside "Import downloaded mods", so the two imports in the Actions row read the same way.
  - The dialog announces itself as a dialog, takes focus on open and restores it on close, which the older info dialog it is modelled on does not yet do. It is registered with the deck-bound modals so teardown settles it.
  - 14 files (+265 / −1): `src/content/`, `locales`
- [`11c8961`](https://github.com/thomasthanos/nexusmods-bypass/commit/11c8961de88ae13a33dc39e19bce16ea1395ced4) Offer the Wabbajack import from the collection deck as well
  - The settings dialog reaches every Nexus page, but when a collection deck is already open that is where the user is looking, and its Actions row is where the other import lives.
  - NDC carries the flag, set on both init paths and refreshed by applySettings, so the deck renders against it rather than reading storage while it builds.
  - 3 files (+15 / −3): `src/content/`, `CHANGELOG.md`
- [`8fb8948`](https://github.com/thomasthanos/nexusmods-bypass/commit/8fb8948db22c58d51c7aa592a81b9ed6be7c3831) Add the Wabbajack import UI behind a beta switch, off by default
  - Turning on "Wabbajack modlist import (beta)" in the page settings adds an Import Wabbajack modlist button to that dialog.
  - Picking a file parses it, reports how many of its archives were queued and how many were left out, and mounts the normal collection deck with the result.
  - 18 files (+360 / −2): `src/content/`, `CHANGELOG.md`, `src/background.js`, `src/shared.js`, `locales`
- [`4aa398a`](https://github.com/thomasthanos/nexusmods-bypass/commit/4aa398a80c91f144dabf1f51c44d09cc00806d69) Add a dependency-free .wabbajack modlist reader
  - Foundation for importing a Wabbajack modlist as a download queue. No UI yet — this is the parsing layer plus its tests.
  - The userscript this comes from pulls zip.js from a CDN, which Manifest V3 blocks outright, so the ZIP reading is ours: end-of-central-directory scan, ZIP64 for the multi-gigabyte archives real modlists produce, central directory w…
  - 4 files (+518 / −0): `tools/`, `src/content/`, `src/manifest.json`

### Changed

- [`186d148`](https://github.com/thomasthanos/nexusmods-bypass/commit/186d148d0505887650c8109b3c9e0397d298f424) Remove unused folder
  - 2 files (+0 / −2050): `you need to add this (gitgnore this folder)/`
- [`20614f9`](https://github.com/thomasthanos/nexusmods-bypass/commit/20614f9b28be2069c9f8950a0e979308840cb463) Update manifest.json — version → **2.6.0**
  - 1 file (+2 / −2): `src/manifest.json`
- [`30c8320`](https://github.com/thomasthanos/nexusmods-bypass/commit/30c83209ce201ced36251691b3db3aa108a6eb90) Name every skipped archive, guard the import, and see Cloudflare in the worker
  - A feature-by-feature audit of the userscript against the port turned up 133 capabilities: 76 ported, 31 already covered by the extension, 5 deliberately excluded, and 18 genuinely missing. These are the ones worth fixing now.
  - The worst was self-inflicted. wabbajack.js records a reason for every archive it cannot queue, and the info dialog promised those entries are named - but the summary printed only a count, so a user importing a list with thirty non…
  - 17 files (+148 / −36): `CHANGELOG.md`, `src/background.js`, `src/content/`, `tools/`, `locales`
- [`f236198`](https://github.com/thomasthanos/nexusmods-bypass/commit/f23619852e3cf2aa4aa793b802b66dd9cc16d898) update
  - 14 files (+40 / −39): `.gitignore`, `locales`
- [`523e819`](https://github.com/thomasthanos/nexusmods-bypass/commit/523e819b93c0774043ab2e10fa78deb199b35e3a) Skip the Nexus ad timer, and map a modlist onto the existing queue
  - Ad timer: Nexus decides whether a download's ad countdown has elapsed from a first-party "ab" cookie shaped &lt;group&gt;|&lt;unix seconds&gt;.
  - The cookie is first-party, expires by itself after five minutes and is never read back. PRIVACY.md said the extension makes only the requests the browser would make on its own;
  - 19 files (+172 / −63): `src/content/`, `PRIVACY.md`, `tools/`, `locales`
- [`7b7959c`](https://github.com/thomasthanos/nexusmods-bypass/commit/7b7959cd830e5f031658ad1d0c62ea52f7cb7e09) Harden the collection queue, cut steady-state cost, close a11y and i18n gaps
  - Queue and worker state: - Job state was persisted by writing a whole job object back, but callers held that snapshot across several awaits.
  - Manual downloads: - The capture-phase click interceptor cancelled Nexus's own Manual and Slow download buttons and substituted its own resolution.
  - 31 files (+773 / −208): `src/content/`, `src/popup/`, `tools/`, `.gitignore`, `locales`

### Fixed

- [`b17379d`](https://github.com/thomasthanos/nexusmods-bypass/commit/b17379d802a063d9abf574a8e7daec3647b3541b) resolve stuck manual downloads and missing Vortex imports in collections
  - fix(downloads): resolve click interceptor locks and manual import issues for collections
  - Release failed downloads back to native Nexus handlers on specific resolution errors (no_download_url, no_nmm_link, unsafe_download_url) - Bypass click interception when modifier keys (Ctrl, Shift, Alt) or middle-click are used -…
  - 28 files (+2462 / −154): `src/content/`, `tools/`, `you need to add this (gitgnore this folder)/`, `CHANGELOG.md`, `locales`

### Docs

- [`9ef54df`](https://github.com/thomasthanos/nexusmods-bypass/commit/9ef54df23986f7cd1665f1e3d8bd172d67511907) Bump cache for text position fix
  - 1 file (+1 / −1): `README.md`
- [`74ae551`](https://github.com/thomasthanos/nexusmods-bypass/commit/74ae5512120a8a8ff6b5a78aab50ec63f1b66cf0) Adjust text positioning in spec-nexus-v2.svg
  - 1 file (+2 / −2): `.github/`
- [`79d5610`](https://github.com/thomasthanos/nexusmods-bypass/commit/79d5610c740573c995b2c711a659bffc32dce544) Bust cache for spec-nexus-v2.svg
  - 1 file (+1 / −1): `README.md`
- [`584d5e5`](https://github.com/thomasthanos/nexusmods-bypass/commit/584d5e55811dafef4c489b64357aa1592335029c) Fix 2.4.2 to 2.6.0 in spec-nexus-v2.svg
  - 1 file (+1 / −1): `.github/`
- [`9bb904e`](https://github.com/thomasthanos/nexusmods-bypass/commit/9bb904ecae7d89ebab037351444f23444a96c11e) Rename SVGs to force github cache invalidation
  - 3 files (+2 / −2): `.github/`, `README.md`
- [`702cd0e`](https://github.com/thomasthanos/nexusmods-bypass/commit/702cd0e46424c7548b343d237a93053f5c9eb2f1) Bust camo cache for spec-nexus.svg again
  - 1 file (+224 / −224): `README.md`
- [`3cbc183`](https://github.com/thomasthanos/nexusmods-bypass/commit/3cbc183066bb1f37d94d78df58998faa409b10c8) Update spec-nexus.svg lines count to 12.8k
  - 1 file (+2 / −2): `.github/`
- [`de9c125`](https://github.com/thomasthanos/nexusmods-bypass/commit/de9c125686b0d5a4e00fd2c44faf81c58698d822) Update spec-nexus.svg to 2.6.0
  - 1 file (+1 / −0): `.github/`
- [`4c58a9a`](https://github.com/thomasthanos/nexusmods-bypass/commit/4c58a9ac53d0860224040958a597e936bf84169b) Bust camo cache for SVG assets
  - 1 file (+2 / −2): `README.md`
- [`428a7ef`](https://github.com/thomasthanos/nexusmods-bypass/commit/428a7ef8d17b0be6c20ad0133e33d65e67cb807a) Update version to v2.6.0 in banner
  - 1 file (+1 / −1): `.github/`
- [`955481d`](https://github.com/thomasthanos/nexusmods-bypass/commit/955481d985c2aa4e1fe93911e9ea8fc63934a1db) Update README.md with Wabbajack modlist import feature
  - 1 file (+2 / −1): `README.md`

## 2026-08-28

**Versions / tags:** tag `2.5.2` · **2.5.2** · **2.5.1**

### Changed

- [`03118e0`](https://github.com/thomasthanos/nexusmods-bypass/commit/03118e0eb5c9d05e9a9c41190951fff77d456968) patch
  - 3 files (+11 / −9): `.github/`, `README.md`
- [`be10491`](https://github.com/thomasthanos/nexusmods-bypass/commit/be104911137ebb1100f577e861435e6303fa788d) patch
  - 5 files (+74 / −4): `.github/`, `README.md`
- [`d128a0c`](https://github.com/thomasthanos/nexusmods-bypass/commit/d128a0c5af065dfde862b7caa8de417d89d23346) patch
  - 4 files (+66 / −11): `.github/`, `README.md`
- [`1227314`](https://github.com/thomasthanos/nexusmods-bypass/commit/1227314587a0a2fcd09c381b0405b00a1d3c5583) patch
  - 2 files (+13 / −2): `.gitignore`, `README.md`
- [`eaece6e`](https://github.com/thomasthanos/nexusmods-bypass/commit/eaece6ee510c048c20c0f88ece5a2c68562569f4) Release v2.5.2 — Popup and page settings redesign — version → **2.5.2**
  - 2 files (+3 / −1): `CHANGELOG.md`, `src/manifest.json`
- [`4179e47`](https://github.com/thomasthanos/nexusmods-bypass/commit/4179e47f8996418ccb307efb118c50c719ef25ae) Redesign popup and page settings layout
  - Popup: one stable height across both tabs (Controls and Help & Bugs differed by ~170px, so the window jumped on every switch), 380px wide, version moved into a header pill, sliding tab indicator, and the Help tab shows the three s…
  - Page settings: two proportioned columns instead of grid areas with a row span, which had stretched Language, Files & Pacing and Advanced past their content and left the dead space inside those cards.
  - 7 files (+441 / −284): `src/popup/`, `src/content/`, `CHANGELOG.md`
- [`4f4f336`](https://github.com/thomasthanos/nexusmods-bypass/commit/4f4f3361a0ec97688b735d75fcafff2cceea9ab2) Update .gitignore
  - 1 file (+1 / −0): `.gitignore`

### Fixed

- [`e807883`](https://github.com/thomasthanos/nexusmods-bypass/commit/e807883198f9fc983069782cbb7bd7ae8bcc2b1d) Fix Vortex preflight and compact settings UI — version → **2.5.1**
  - This update tightens the Vortex download flow by confirming the app is running before collection links are sent, honoring browser fallback choice, and showing explicit 'Sent to Vortex' status instead of claiming a file downloaded.…
  - 10 files (+426 / −20): `src/content/`, `src/popup/`, `tools/`, `CHANGELOG.md`

### Docs

- [`dc5a224`](https://github.com/thomasthanos/nexusmods-bypass/commit/dc5a224d758fdfeab45a576233681cd30da314ca) Update README.md
  - 1 file (+3 / −3): `README.md`

### Merged

- [`dc24d77`](https://github.com/thomasthanos/nexusmods-bypass/commit/dc24d7793632ad20b69fda2aa704a414e6c8b58a) Merge branch 'main' of https://github.com/thomasthanos/nexusmods-bypass — tagged `2.5.2`
  - 1 file (+1 / −0): `.gitignore`

## 2026-08-27

**Versions / tags:** tag `v2.5.0` · **2.5.0** · **2.4.5**

### Changed

- [`c7f70f0`](https://github.com/thomasthanos/nexusmods-bypass/commit/c7f70f063591920a7d7c488297c48ebda7f0caa3) Release v2.5.0 — Tabbed popup UX & donation options — tagged `v2.5.0`
  - 2 files (+8 / −1): `CHANGELOG.md`, `src/popup/`
- [`21f3b72`](https://github.com/thomasthanos/nexusmods-bypass/commit/21f3b723f03b24d99385662f5bf47967ab468e1d) patch
  - 13 files (+156 / −195): `locales`
- [`a8f6f8f`](https://github.com/thomasthanos/nexusmods-bypass/commit/a8f6f8f2f1cd719f81532c6951f6baaeaafe1418) Update manifest.json — version → **2.5.0**
  - 1 file (+8 / −4): `src/manifest.json`
- [`eff7731`](https://github.com/thomasthanos/nexusmods-bypass/commit/eff7731719dfb2c3048caed7b63a3ff5ac381868) Refresh onboarding and popup UX
  - This commit modernizes the onboarding page with a richer hero layout, SVG iconography, responsive scaling, and stronger visual polish.
  - 5 files (+633 / −189): `src/popup/`, `src/onboarding/`

### Fixed

- [`d0856ad`](https://github.com/thomasthanos/nexusmods-bypass/commit/d0856ad0f65c8b75d25f01c275b723eb49d0a1c0) Release 2.4.5 — Cloudflare fallback & fixes — version → **2.4.5**
  - Bump version to 2.4.5 and add Cloudflare fallback UX and controls. Introduces a CloudflareFallback setting, watchdog/deadline for native fallback, activity tracking (setActivity/describeActivity), and richer session info in bug re…
  - 28 files (+1343 / −90): `src/content/`, `src/popup/`, `CHANGELOG.md`, `README.md`, `locales`
- [`1cd42ca`](https://github.com/thomasthanos/nexusmods-bypass/commit/1cd42ca46a46884b92eee2f9d978727bdc85ffe3) Handle Cloudflare fallback and close-tab races
  - When Cloudflare challenges a hidden download request, the flow now falls back to Nexus's native download control or opens the file page for verification instead of retrying a request that cannot complete the challenge.
  - 3 files (+323 / −11): `src/content/`, `CHANGELOG.md`

### Docs

- [`3c18558`](https://github.com/thomasthanos/nexusmods-bypass/commit/3c18558dc6126668d477dde216e6b56c447df728) docs: Add official extension store links
  - 1 file (+3 / −3): `README.md`
- [`a5065df`](https://github.com/thomasthanos/nexusmods-bypass/commit/a5065df72507e1eb25b138e92116e628c92f3c5e) docs: Emphasize official store installation and hide manual methods
  - 1 file (+15 / −9): `README.md`
- [`c465955`](https://github.com/thomasthanos/nexusmods-bypass/commit/c465955742760c1134f2c63eb10a765a8c4b7cf4) docs: Update installation guide to use GitHub Releases
  - 1 file (+11 / −14): `README.md`
- [`c2e4285`](https://github.com/thomasthanos/nexusmods-bypass/commit/c2e42858959d1186e80f70d489e8f99a70f418ea) Add SECURITY.md
  - 1 file (+24 / −0): `SECURITY.md`

## 2026-08-24

**Versions / tags:** **2.4.4**

### Added

- [`cf0a3c9`](https://github.com/thomasthanos/nexusmods-bypass/commit/cf0a3c985da0e60c707487bede52d9d5b8d4946f) Restructure repo, add Firefox build & bump v2.4.4 — version → **2.4.4**
  - Move extension sources into src/ and internal assets/docs into internal/; update .gitignore accordingly. Bump manifest version to 2.4.4 and update README/CHANGELOG with Firefox packaging and fixes.
  - 50 files (+258 / −1477): `nexus.mods.bypass/`, `.gitignore`

### Changed

- [`2246c86`](https://github.com/thomasthanos/nexusmods-bypass/commit/2246c8667f7512e73027915b519f8fa0a4928d7d) refactor: make NexusMods Bypass a standalone repository
  - 258 files (+220 / −55292): `An1me_tracker/`, `.github/`, `{nexus.mods.bypass/`, `auto-liker-extension/`
- [`727b706`](https://github.com/thomasthanos/nexusmods-bypass/commit/727b706e1c13488d9e42c943bd781c4b14ffe771) Restore store-assets to version control
  - e8911bd untracked nexus.mods.bypass/internal/store-assets on a misread request; promo was the intended target and has never been tracked at all. The nine listing assets and their .gitignore entry are back exactly as they were.
  - The LICENSE path corrections from that commit stand — they fixed references broken by the src//internal/ restructure and are unrelated to what is tracked.
  - 11 files (+53 / −6): `nexus.mods.bypass/`, `.gitignore`

### Docs

- [`e8911bd`](https://github.com/thomasthanos/nexusmods-bypass/commit/e8911bd69fb998da77ab65c3eca0c4f43d14e4e1) Stop tracking store-assets; fix stale paths in LICENSE
  - The 3.3 MB of screenshots, promo tiles and marquee art under nexus.mods.bypass/internal/store-assets are listing artwork: no build step reads them, the packager's allowlist has never included them, and every clone was carrying the…
  - LICENSE section 3 still pointed at nexus.mods.bypass/icons/ and nexus.mods.bypass/store-assets/, both moved by the src//internal/ restructure in the previous commit.
  - 12 files (+10 / −56): `nexus.mods.bypass/`, `.gitignore`, `LICENSE`

## 2026-08-23

<details>
<summary><sub>4 commits for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- [`fa07b1d`](https://github.com/thomasthanos/nexusmods-bypass/commit/fa07b1d5bbb283115c67f4d8e9699fdf5f6c81b6) patch
- [`073792b`](https://github.com/thomasthanos/nexusmods-bypass/commit/073792bc04fafdd2dcbd36a82ff240cde4bb9bba) Add an1me gateway, auto-resume & metadata fixes
- [`0c9fa81`](https://github.com/thomasthanos/nexusmods-bypass/commit/0c9fa81ab5b0d69675a3561c1d8105816249197e) Update manifest.json
- [`edb0886`](https://github.com/thomasthanos/nexusmods-bypass/commit/edb0886748ee989f40888d4a4620eaabe9a0b19c) Auto-pick premium server variants

</details>

## 2026-08-22

<details>
<summary><sub>4 commits for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- [`78016d6`](https://github.com/thomasthanos/nexusmods-bypass/commit/78016d6b6623ee889d11accfc10f41744ac788f3) Update manifest.json
- [`6ac18eb`](https://github.com/thomasthanos/nexusmods-bypass/commit/6ac18ebb4ee1b9e4dc98d90b413239da7848803d) Add in-page bridge for an1me fetches
- [`5f7089b`](https://github.com/thomasthanos/nexusmods-bypass/commit/5f7089b392ad31dd72e79a165a0e3385d17f6611) Revert "patch"
- [`992dccb`](https://github.com/thomasthanos/nexusmods-bypass/commit/992dccbf523662527f1c46c128bd07b14bf52fda) patch

</details>

## 2026-08-17

<details>
<summary><sub>4 commits for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- [`e54972f`](https://github.com/thomasthanos/nexusmods-bypass/commit/e54972ffc7bece82f526577da493a9ba07faaaf6) adblcoker
- [`932010a`](https://github.com/thomasthanos/nexusmods-bypass/commit/932010a461b38f421864cfb97a1874523272dcab) patch
- [`7efc1d5`](https://github.com/thomasthanos/nexusmods-bypass/commit/7efc1d56b6a50f2e5df26857519fa566aead9c77) Update manifest.json
- [`ad814ad`](https://github.com/thomasthanos/nexusmods-bypass/commit/ad814ad461dcc1903aaf6232c4141810ba677d75) patch

</details>

## 2026-08-16

<details>
<summary><sub>1 commit for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- [`e8974d6`](https://github.com/thomasthanos/nexusmods-bypass/commit/e8974d62c3be3ebb61677ea92d34928a9a081506) Improve caching, UI, AniList episode placeholders

</details>

## 2026-08-10

**Versions / tags:** **2.4.3**

### Changed

- [`f46b3d0`](https://github.com/thomasthanos/nexusmods-bypass/commit/f46b3d0cacce086c6b6f09f586c1f5db6282fb49) nexus.mods.bypass: v2.4.3 — remove HideDownloadBar — version → **2.4.3**
  - Bumps nexus.mods.bypass to 2.4.3 and removes the profile‑wide HideDownloadBar feature.
  - 28 files (+417 / −255): `nexus.mods.bypass/`, `.github/`, `.gitignore`, `PRIVACY.md`

## 2026-08-06

<details>
<summary><sub>1 commit for other extensions that shared the repository before the split (not part of NexusMods Bypass)</sub></summary>

- [`0fb77e2`](https://github.com/thomasthanos/nexusmods-bypass/commit/0fb77e2f4d7c2965e711a1cfe80157ee583af577) Update .gitignore

</details>

## 2026-08-04

### Changed

- [`05b827a`](https://github.com/thomasthanos/nexusmods-bypass/commit/05b827a99196733d82f7f36bc23cb77a0e3541bf) patch
  - 283 files (+84861 / −0): `.github/`, `An1me_tracker/`, `nexus.mods.bypass/`, `auto-liker-extension/`

<img src="docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
