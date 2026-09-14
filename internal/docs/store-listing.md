# Store listing — ready-to-paste text

Source of truth for the Chrome Web Store and Edge Add-ons listings. Update this file when
the listing changes, so the dashboard copy can always be rebuilt from the repo.

## Name

`NexusMods Bypass` — comes from `_locales/<lang>/messages.json` → `appName`.

## Short description

Comes from the manifest (`__MSG_appDesc__`), so the store shows it **already translated**
for every locale in `_locales/`. Current English text (116 / 132 chars):

> Auto-start Nexus Mods downloads, queue whole collections to Vortex or your browser, and skip
> files you already have.

Edit it in `_locales/en/messages.json` (and the other locales), not in the dashboard.

## Detailed description

The dashboard's detailed description is **not** covered by `_locales` — it has to be pasted
per language in the store UI. Paste this into the "Description" field:

```
NexusMods Bypass streamlines downloading on Nexus Mods. It skips the download wait on supported file pages, starts downloads automatically, and sends them to Vortex or your browser.

On collection pages you can download the whole collection, or only the files you pick, with a live progress bar, pacing controls and a download history, so a re-run only fetches what is missing. It can also queue the Nexus files of a Wabbajack modlist (beta).

It runs only on nexusmods.com and keeps everything in your browser. You must be signed in to your own Nexus Mods account; it does not unlock Premium content and is not affiliated with Nexus Mods.
```

## What's new — 2.7.0

Dashboard-only field, not covered by `_locales`. Paste as-is:

```
Lighter on every Nexus Mods page.

The collection downloader, the settings, the bug reporter and the Wabbajack importer now load only on the pages that use them, so every other Nexus page carries about half as much of the extension. This uses the "scripting" permission, which shows no warning and gives the extension no access beyond nexusmods.com.

A file page opened in a background tab starts its download straight away; a Vortex handoff still waits until you look at the tab. An imported Wabbajack modlist now opens where the collection downloader was, instead of at the top of the page, and can be closed again.

The "downloads.ui" permission is gone. The "downloads" permission, which runs your downloads, stays.
```

Keep this honest and specific. The setting caused support confusion precisely because the
symptom was untraceable; a vague "bug fixes and improvements" line would repeat that.

## Category

Productivity → Workflow & Planning

## Search keywords woven into the copy

Nexus Mods, Vortex, mod manager, collection downloader, auto download, skip wait, download
helper, Skyrim, Fallout, modding

## Assets — all present in `../store-assets/` (the folder moved under `internal/`)

| Asset | Size | File |
|---|---|---|
| Screenshots | 1280×800 | `1280.png`, `1280_1.png` … `1280_4.png` |
| Small promo tile | 440×280 | `canvas-440x280.png` |
| Marquee | 1400×560 | `marquee-1400x560.png` |

## Privacy tab answers

- **Single purpose:** This extension improves the Nexus Mods download workflow: it automates the supported download steps, starts downloads on supported file pages, and downloads full collections (or Wabbajack modlists' Nexus files) as a paced queue. It runs only on nexusmods.com.
- **Data collected:** none — all storage is local. Link
  [PRIVACY.md](https://github.com/thomasthanos/nexusmods-bypass/blob/main/PRIVACY.md)
  as the privacy policy URL. It lives at the repo root, not under `nexus.mods.bypass/` —
  the old path 404s, and the store will not approve a dead privacy policy link.
- **Permissions justification:**

| Permission | Justification |
|---|---|
| `storage` | Storage keeps the user's data locally in the browser: settings (auto-download behaviour, queue pacing, download method, download folder, language), the collection download history so re-runs skip files already downloaded, the state of a running download queue so it survives the service worker being suspended, a download counter, and a small local error log the user can attach to a bug report. Nothing is sent off the device. |
| `downloads` | The downloads permission is essential to the extension's single purpose. After the user starts a Nexus Mods file, collection or modlist download, the extension starts the browser download, gives it a safe filename inside the configured Downloads subfolder, and follows it until it completes or is interrupted, checking the finished size, so a collection queue can continue or resume. It cancels only the queue downloads it started, when the user selects Stop. Downloads stay in the browser's download history. |
| `scripting` | The scripting permission injects the extension's own packaged scripts into a nexusmods.com tab only when that page needs them: the collection downloader on a collection page, the settings dialog when the user opens it, the bug-report builder when an error dialog is shown, and the Wabbajack importer when the user uses it. This keeps the script loaded on every Nexus Mods page small. Only files inside the extension package are injected, only into the frame that asked, and only on the host the extension already has access to. No remote code is used. |
| `alarms` | The alarms permission schedules one-time wake-ups for an active browser-mode download queue only: to start the next file after the pause between downloads and to resume after a Nexus Mods rate-limit cooldown. A Manifest V3 service worker cannot keep a timer while suspended, so this lets the queue continue after browser suspension or device sleep. It is not used for notifications, analytics, advertising or unrelated periodic work. |
| `https://www.nexusmods.com/*` | Access to https://www.nexusmods.com/* is required because the extension works only on Nexus Mods. It needs this host to add its interface to Nexus Mods pages, recognise supported download pages, request the download links for the files the user asks for, and run collection downloads. The extension does not run on or read any other website. |

## Before each submission

- [ ] Version bumped in `manifest.json` — it is the only place the version lives
- [ ] `CHANGELOG.md` has an entry for the new version
- [ ] `node tools/build-zip.mjs` passes and writes `dist/nexus.mods.bypass-<version>.zip`
- [ ] That zip is the one uploaded — never a hand-made archive

The build script gates on `check-locales.mjs` and every regression suite in `tools/`, packages from an explicit allowlist, and
fails if the manifest references a file the package does not carry. It replaces the manual
"zip everything except…" step, which is how `docs/`, `README.md` and `PRIVACY.md` ended up
published inside the 2.4.2 package.

## Release history worth remembering

The 2.4.2 upload shipped this very file inside the extension. Anyone who unpacked the CRX
could read the listing notes. Fixed in 2.4.3 by the allowlist in `tools/build-zip.mjs` —
do not go back to packaging by hand.
