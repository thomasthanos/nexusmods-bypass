<p align="center">
  <img src="../../docs/assets/header-fixtures.svg" alt="Page fixtures" width="100%" />
</p>

<p align="center"><sub><a href="../../README.md">← README</a> · <a href="../../PRIVACY.md">Privacy</a> · <a href="../../.github/CONTRIBUTING.md">Contributing</a> · <a href="../../CHANGELOG.md">Changelog</a></sub></p>

<img src="../../docs/assets/divider.svg" alt="" width="100%" />


Small, sanitized HTML snapshots shaped like the Nexus Mods pages the content scripts read. They keep
only the structure the extension finds its way by (ids, custom elements, the account menu, the download
card) and carry no user data, tokens, scripts or ads. Live pages sit behind Cloudflare and change often,
so these are reduced by hand; when Nexus changes a hook, update the fixture and `src/lib/selectors.js`
together and keep `tests/unit/dom-fixtures-test.mjs` green.

Two JSON files hold the report contract that the extension, the relay and the diagnostics Worker are all
tested against. `relay-reports.json` has one report of each kind the extension sends the relay; the
extension's tests check that what it builds has exactly these fields, and the relay's and the diagnostics
Worker's tests send them. `report-schemas.json` is the JSON Schema of the reports the diagnostics Worker
accepts, written by `node tools/export-report-schemas.mjs` in `workers/diagnostics/` from its Zod schemas; a
diagnostics test fails while it is out of date.

<img src="../../docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="../../docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
