# Page fixtures

Small, sanitized HTML snapshots shaped like the Nexus Mods pages the content scripts read. They keep
only the structure the extension finds its way by (ids, custom elements, the account menu, the download
card) and carry no user data, tokens, scripts or ads. Live pages sit behind Cloudflare and change often,
so these are reduced by hand; when Nexus changes a hook, update the fixture and `src/selectors.js`
together and keep `tools/dom-fixtures-test.cjs` green.
