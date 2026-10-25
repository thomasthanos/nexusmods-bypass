<p align="center">
  <img src="docs/assets/header-notices.svg" alt="Third-party notices - NexusMods Bypass" width="100%" />
</p>

<p align="center">
  <a href="README.md"><kbd> ← README </kbd></a>&ensp;·&ensp;
  <a href="PRIVACY.md"><kbd> 🔒 Privacy </kbd></a>&ensp;·&ensp;
  <a href="CONTRIBUTING.md"><kbd> 🤝 Contributing </kbd></a>&ensp;·&ensp;
  <a href="CHANGELOG.md"><kbd> 📋 Changelog </kbd></a>
</p>

<img src="docs/assets/divider.svg" alt="" width="100%" />


NexusMods Bypass is a plain JavaScript browser extension. It contains no framework, bundled third-party runtime, remotely loaded code, advertising SDK, or analytics SDK.

## Nexus No Wait ++

<a href="src/content/nnw.js"><kbd><code>src/content/nnw.js</code></kbd></a> is based on **Nexus No Wait ++** by Torkelicious and
upstream contributors:

- Upstream repository: <a href="https://github.com/torkelicious/nexus-no-wait-pp"><kbd>torkelicious/nexus-no-wait-pp</kbd></a>
- Published userscript: <a href="https://greasyfork.org/scripts/519037-nexus-no-wait"><kbd>Nexus No Wait ++ on Greasy Fork</kbd></a>
- Licence: <a href="src/LICENSE-GPL-3.0-or-later.txt"><kbd>GNU GPL version 3 or later</kbd></a>

Thomas Thanos maintains the extension adaptation and its subsequent modifications. The Nexus No
Wait ++ maintainer has confirmed that `nnw.js` may be distributed as part of NexusMods Bypass under
GPL-3.0-or-later with this attribution, while the remaining original extension code retains its
current licence. The repository's main <a href="LICENSE"><kbd>licence</kbd></a> documents that scope.

Reading download links out of Nexus Mods responses is handled by
<a href="src/lib/download-url-parser.js"><kbd><code>src/lib/download-url-parser.js</code></kbd></a>, which both `nnw.js` and the background
worker call. That file is original NexusMods Bypass code under the main licence; `nnw.js` no longer
contains a parser of its own.

## Nexus Mods and Vortex

The extension operates on Nexus Mods pages and can hand download links to Vortex. *Nexus Mods*, *Vortex*, their logos, product names, site content, and trademarks belong to their respective owners.

NexusMods Bypass is not affiliated with, endorsed by, sponsored by, or connected to Nexus Mods.

- <a href="https://help.nexusmods.com/article/18-terms-of-service"><kbd>Nexus Mods terms of service</kbd></a>
- <a href="https://help.nexusmods.com/article/20-privacy-policy"><kbd>Nexus Mods privacy policy</kbd></a>

## Browser platforms

Chrome, Chromium, Edge, and Firefox APIs and trademarks belong to their respective owners. Compatibility with a browser does not imply endorsement.

If a notice appears incomplete, open an issue in the <a href="https://github.com/thomasthanos/nexusmods-bypass/issues"><kbd>repository</kbd></a>.

<img src="docs/assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="docs/assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
