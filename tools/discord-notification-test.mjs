import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nxtk-discord-format-'));
try {
  const summary = path.join(dir, 'summary.md');
  fs.writeFileSync(summary, '## Chrome / Edge\n### Permissions (3.1.0 → 3.1.1)\nRemoved: relay host permission\n## Firefox\nFirefox could not be checked.\n@everyone <@123456789012345678>');
  const run = (kind, extra = {}) => {
    const result = spawnSync(process.execPath, ['tools/discord-notification.mjs', kind, summary], {
      encoding: 'utf8', env: { ...process.env, TITLE: 'Permission update', LINK: 'https://github.com/thomasthanos/nexusmods-bypass', EXPANDED: 'false', INCOMPLETE: 'false', ...extra }
    });
    assert.equal(result.status, 0, `formatter must produce a valid payload: ${result.stderr}`);
    const message = JSON.parse(result.stdout);
    assert.equal(message.username, 'NexusMods Bypass · GitHub');
    assert.deepEqual(message.allowed_mentions, { parse: [] });
    assert.equal(message.content, undefined, 'GitHub changes never ping the owner');
    assert.match(message.embeds[0].title, /^GitHub · /);
    assert.ok(message.embeds[0].description.length <= 3900);
    assert.ok(!message.embeds[0].description.includes('@everyone'));
    return message;
  };
  assert.equal(run('manifest').embeds[0].color, 0x3498db);
  assert.equal(run('manifest', { EXPANDED: 'true' }).embeds[0].color, 0xe8b339);
  assert.equal(run('manifest', { INCOMPLETE: 'true' }).embeds[0].color, 0xe8b339);
  assert.equal(run('schema').embeds[0].color, 0xe8b339);
  assert.equal(run('release', { R_NAME: '3.1.1', R_URL: 'https://github.com/thomasthanos/nexusmods-bypass/releases/tag/3.1.1', R_BODY: '<p><img src="banner.svg" /></p>\n<details>\n<summary>Updates</summary>\n- New reports\n</details>' }).embeds[0].color, 0x57f287);
  assert.equal(run('issue', { I_TITLE: 'A bug', I_URL: 'https://github.com/thomasthanos/nexusmods-bypass/issues/1', I_USER: 'tester' }).embeds[0].color, 0x3498db);
  fs.writeFileSync(summary, 'x'.repeat(7000));
  assert.ok(run('schema').embeds[0].description.length <= 3900);
  console.log('Discord GitHub formatting OK: distinct source, colours, safe mentions and bounded payloads.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
