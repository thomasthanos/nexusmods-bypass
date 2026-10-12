<p align="center">
  <img src="../../docs/assets/header-fixtures.svg" alt="Page fixtures" width="100%" />
</p>

<p align="center"><sub><a href="../../README.md">← README</a> · <a href="../../PRIVACY.md">Privacy</a> · <a href="../../CONTRIBUTING.md">Contributing</a> · <a href="../../CHANGELOG.md">Changelog</a></sub></p>

<img src="../../docs/assets/divider.svg" alt="" width="100%" />


Small, sanitized HTML snapshots shaped like the Nexus Mods pages the content scripts read. They keep
only the structure the extension finds its way by (ids, custom elements, the account menu, the download
card) and carry no user data, tokens, scripts or ads. Live pages sit behind Cloudflare and change often,
so these are reduced by hand; when Nexus changes a hook, update the fixture and `src/selectors.js`
together and keep `tools/dom-fixtures-test.cjs` green.

<img src="../../docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="../../docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
