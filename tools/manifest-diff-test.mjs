import assert from 'node:assert/strict';
import { diffManifests, summarize } from './manifest-diff.mjs';

const base = { version: '2.8.1', permissions: ['storage'], host_permissions: ['https://www.nexusmods.com/*'], content_scripts: [{ matches: ['https://www.nexusmods.com/*'] }] };
let r = diffManifests(base, { ...base, version: '2.9.0' });
assert.equal(r.changes.length, 0);
assert.match(summarize(r), /No changes/);

r = diffManifests(base, { ...base, optional_host_permissions: ['https://relay.example/*'] });
assert.equal(r.changes.length, 1);
assert.equal(r.expanded, false, 'optional permissions add no install-time warning');

r = diffManifests(base, { ...base, permissions: ['storage', 'tabs'], content_scripts: [{ matches: ['<all_urls>'] }] });
assert.equal(r.expanded, true);
assert.match(summarize(r), /expands what the extension can access/);
assert.match(summarize(r), /`tabs`/);

r = diffManifests(base, { ...base, permissions: [] });
assert.equal(r.expanded, false, 'removing a permission is not an expansion');
assert.deepEqual(r.changes[0].removed, ['storage']);
console.log('manifest diff behavior OK');
