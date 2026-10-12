<p align="center">
  <img src="docs/assets/header-contributing.svg" alt="Contributing to NexusMods Bypass" width="100%" />
</p>

<p align="center">
  <a href="README.md"><img src="docs/assets/link-readme.svg" alt="Back to the README" height="42" /></a>
  <a href="PRIVACY.md"><img src="docs/assets/link-privacy.svg" alt="Privacy" height="42" /></a>
  <a href="CONTRIBUTING.md"><img src="docs/assets/link-contributing.svg" alt="Contributing" height="42" /></a>
  <a href="CHANGELOG.md"><img src="docs/assets/link-changelog.svg" alt="Changelog" height="42" /></a>
  <a href="LICENSE"><img src="docs/assets/link-license.svg" alt="Licence" height="42" /></a>
</p>

<img src="docs/assets/divider.svg" alt="" width="100%" />


Bug reports and focused pull requests are welcome. Before contributing, read the source-available
[licence](LICENSE). Contributions are licensed to the project owner under its terms, except for
changes made specifically to `src/content/nnw.js`, which must be submitted under
[GPL-3.0-or-later](src/LICENSE-GPL-3.0-or-later.txt).

## Reporting a bug

Use the [guided issue form](https://github.com/thomasthanos/nexusmods-bypass/issues/new/choose) and include:

- extension version
- browser and browser version
- collection or download mode involved
- what you expected
- what happened instead
- the generated error report, when available

Do not include Nexus credentials, cookies, tokens, or private URLs.

## Sending a pull request

1. Fork the repository and create a focused branch.
2. Make the smallest change that solves the problem.
3. Load `src/` as an unpacked extension and exercise the affected flow. In Firefox, load the built
   `dist/nexus.mods.bypass-<version>-firefox.zip` instead — `src/manifest.json` declares a
   `background.service_worker`, which Firefox does not accept; the Firefox manifest is generated
   by `tools/build-zip.mjs`.
4. Run the locale validator when strings change:

   ```bash
   node tools/check-locales.mjs
   ```

5. Run the package builder before submitting. It runs the locale check and every regression suite in
   `tools/` first and packages nothing unless they all pass; the same gate runs on every push:

   ```bash
   node tools/build-zip.mjs
   ```

6. Explain what changed and how it was tested.

Keep permissions narrow, do not add remote code or telemetry, and do not commit generated archives from `dist/`.

## Scope

Good contributions include bug fixes, compatibility updates, translation corrections, accessibility improvements, and narrowly justified features. Changes that weaken privacy, broaden host access without need, hide behaviour, or add analytics will not be accepted.

<img src="docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
