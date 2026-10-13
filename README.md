<p align="center">
  <img src="docs/assets/hero.svg" alt="NexusMods Bypass: queue Nexus Mods collections, skip repetitive steps, and resume your queue" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/thomasthanos/nexusmods-bypass/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/thomasthanos/nexusmods-bypass?display_name=tag&style=flat-square&color=f0a24d&labelColor=151c31" /></a>
  <a href="https://github.com/thomasthanos/nexusmods-bypass/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/thomasthanos/nexusmods-bypass/total?style=flat-square&label=downloads&color=8b83ff&labelColor=151c31" /></a>
  <img alt="Chrome, Edge, Firefox 140+" src="https://img.shields.io/badge/chrome%20%C2%B7%20edge%20%C2%B7%20firefox-MV3-45c8e6?style=flat-square&labelColor=151c31" />
  <a href="LICENSE"><img alt="Licence: source-available" src="https://img.shields.io/badge/licence-source--available-f0b86e?style=flat-square&labelColor=151c31" /></a>
</p>

<p align="center">
  <a href="https://github.com/thomasthanos/nexusmods-bypass/releases/latest"><img src="docs/assets/download.svg" alt="Download the latest release" width="380" /></a>
  <br /><br />
  <a href="https://chromewebstore.google.com/detail/nexusmods-bypass/chfghiknjhpcncpcjopglefnckckdlpj"><img src="docs/assets/pill-chrome.svg" alt="Chrome Web Store" height="28" /></a> <a href="https://addons.mozilla.org/en-US/firefox/addon/nexusmods-bypass/"><img src="docs/assets/pill-firefox.svg" alt="Firefox Add-ons" height="28" /></a> <a href="https://microsoftedge.microsoft.com/addons/detail/hcjpcnajmkanhodhpkoinodjbkeolgaa"><img src="docs/assets/pill-edge.svg" alt="Edge Add-ons" height="28" /></a> &nbsp;&nbsp; <a href="CHANGELOG.md"><img src="docs/assets/pill-changelog.svg" alt="Changelog" height="28" /></a> <a href="PRIVACY.md"><img src="docs/assets/pill-privacy.svg" alt="Privacy" height="28" /></a> <a href="#bugs"><img src="docs/assets/pill-bug.svg" alt="Report a bug" height="28" /></a>
</p>

<img src="docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <img src="docs/assets/features.svg" alt="Fewer clicks, collection queue, resume, official Nexus API, Wabbajack (beta), safer Vortex handoff, reports and debug log, 13 languages" width="100%" />
</p>

<p align="center">
  <img src="docs/assets/install-steps.svg" alt="Download the ZIP, load it, sign in to Nexus Mods" width="100%" />
</p>

<details>
<summary><b>📥 Manual install</b> — <sub>load a release ZIP in Chrome, Edge or Firefox</sub></summary>

**Chrome, Edge, Brave, Opera**
1. Download the latest `nexus.mods.bypass-<version>.zip` from the [Releases page](https://github.com/thomasthanos/nexusmods-bypass/releases/latest).
2. Extract the `.zip` file into a new folder.
3. Open `chrome://extensions` (or `edge://extensions`).
4. Enable **Developer mode** in the top right.
5. Click **Load unpacked** and select the folder you just extracted.

**Firefox 140 or newer**
1. Download the latest `nexus.mods.bypass-<version>-firefox.zip` from the [Releases page](https://github.com/thomasthanos/nexusmods-bypass/releases/latest).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select the `.zip` file directly (no need to extract it).

*Note: A temporary add-on is unloaded when Firefox closes. Installing it permanently requires downloading from the official AMO store.*
</details>

> In **Vortex mode**, keep Vortex running: the browser can confirm a link was sent, not that Vortex finished the download.

## Usage

On first install, the welcome page asks three setup questions and has a **Test Vortex** button. Sign in to Nexus Mods. On a mod's **Files** tab, download as usual. On a **collection**, pick Vortex or browser download in the collection panel and start the queue (keep the tab open). The toolbar popup has quick switches, **Page settings** and **Help & Bugs**. A collection run ends with a summary (sent / skipped / failed, retry failed, copy list); the collection menu's **Download history** shows what was sent to Vortex and resends what is missing.

<img src="docs/assets/divider.svg" alt="" width="100%" />

<h3 align="center">Reference</h3>

<details>
<summary><b>⚙️ Settings</b> — <sub>what each Page settings group controls</sub></summary>

- **Quick setup:** presets *Vortex user*, *Browser downloads* and *Minimal* (a mix shows as *Custom*).
- **Download flow:** auto-start, close the extra tab after sending to Vortex, skip requirements, error popups, hide ads and Premium panels, archived file buttons, Wabbajack import, smallest files first.
- **Files:** browser download folder.
- **Official Nexus API:** use the documented API for collection, mod and file details (on), follow curator update policy (off), endorse and track buttons (on). See [docs/nexus-site-map.md](docs/nexus-site-map.md).
- **Advanced:** request timeout, close-tab delay, Vortex download speed and pause between files, official API, open the file page when Nexus asks for a browser check.
- **Language:** Always use English.
</details>

<details>
<summary><b>🛡️ Privacy &amp; permissions</b> — <sub>what stays local and why each permission is needed</sub></summary>

Settings, history and logs stay in local extension storage; no analytics or accounts. Reports are opt-in and show the exact redacted JSON first. Details: [PRIVACY.md](PRIVACY.md).

| Permission | Used for |
|---|---|
| `storage` | Settings and local download history. |
| `downloads` | Starting and tracking browser downloads. |
| `downloads.ui` | Chrome/Edge only: hides the download bubble while a collection run is active (setting, on by default), restored when the run ends. |
| `scripting` | Injecting the extension's packaged UI on Nexus pages as needed. |
| `alarms` | Pacing the background queue. |
| `https://www.nexusmods.com/*` | The only site the extension operates on. |
| `https://nexusmods-bypass-relay.mariosthanos3.workers.dev/*` (optional) | Requested only when you first send a report; delivers it to the maintainer via the [report relay](relay/README.md). |
</details>

<a id="bugs"></a>
<details>
<summary><b>🐞 Bug reports &amp; debug log</b> — <sub>send a redacted report or record a live log</sub></summary>

- **Send bug report** (popup → Help & Bugs): describe it, review the redacted JSON, then send through the [relay](relay/README.md), save/copy it, or open a prefilled [GitHub issue](https://github.com/thomasthanos/nexusmods-bypass/issues/new/choose).
- **Debug log** (Help & Bugs → Debug log): opt-in live log with filters, search and export.
- **Automatic error reports**: anonymous, off by default.
</details>

<a name="troubleshooting"></a>
<a name="-troubleshooting"></a>
<details open>
<summary><b>🧭 Quick fixes</b> — <sub>common problems and what to try</sub></summary>

<details>
<summary><b>Downloads do not start</b></summary>

Sign in to Nexus Mods and enable **Start downloads automatically** in Page settings.
</details>

<details>
<summary><b>Vortex does not receive the file</b></summary>

Start Vortex first. If it takes time to pick up links, increase **Close-tab delay**.
</details>

<details>
<summary><b>The collection queue pauses or runs slowly</b></summary>

Rate limits pause the queue temporarily; it resumes automatically. Keep the collection tab open and **Hide ads and Premium panels** enabled, so its ad-timer cookie stays current for the background queue.
</details>

<details>
<summary><b>Already downloaded files start again</b></summary>

Choose **Skip Downloaded** when the history dialog appears. Cleared history cannot identify files already on disk.
</details>
</details>

<details>
<summary><b>🛠️ For developers</b> — <sub>build, lint and test commands</sub></summary>

```sh
npm ci && npm run lint
npm run build          # regression checks, then Chrome and Firefox zips
npm run test:visual    # Playwright tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/nexus-site-map.md](docs/nexus-site-map.md) and [SECURITY.md](SECURITY.md).
</details>

<img src="docs/assets/divider.svg" alt="" width="100%" />

## Licence

Source-available under the repository [licence](LICENSE); the name, `src/icons/` and `internal/` are excluded. `src/content/nnw.js` is [GPL-3.0-or-later](src/LICENSE-GPL-3.0-or-later.txt), based on [Nexus No Wait ++](https://github.com/torkelicious/nexus-no-wait-pp) — see [third-party notices](THIRD-PARTY-NOTICES.md).

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
