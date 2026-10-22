import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { githubMessage, sendGithubMessage } from './discord-notification.mjs';

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

  // Issue #29 "[Feature Request] Auto expand requirements screen." was filed through the bug form
  // (the only form then) and came in as "Bug issue", twice.
  const issue = (extra) => githubMessage('issue', { I_URL: 'https://github.com/thomasthanos/nexusmods-bypass/issues/29', I_USER: 'LimeLime875', ...extra }).embeds[0];
  assert.equal(issue({ I_TITLE: '[Bug] Vortex does not open', I_LABEL: 'bug' }).title, 'GitHub · Bug issue: [Bug] Vortex does not open');
  assert.equal(issue({ I_TITLE: 'Auto expand requirements', I_LABEL: 'enhancement' }).title, 'GitHub · Feature request: Auto expand requirements');
  const misfiled = issue({ I_TITLE: '[Feature Request] Auto expand requirements screen.', I_LABEL: 'bug' });
  assert.equal(misfiled.title, 'GitHub · Feature request: [Feature Request] Auto expand requirements screen.', 'a request filed as a bug is still a request');
  assert.match(misfiled.description, /^Opened by LimeLime875\. Open the issue for the full request\.$/);
  assert.match(issue({ I_TITLE: 'Crash', I_LABEL: 'bug' }).description, /full report/);
  const question = issue({ I_TITLE: '[Question] How do I send a collection to Vortex?', I_LABEL: 'question' });
  assert.equal(question.title, 'GitHub · Question: [Question] How do I send a collection to Vortex?', 'the question form has its own notice');
  assert.match(question.description, /full question/);

  // One notice per issue: a form's labels arrive as an "opened" event that already has them and a
  // "labeled" event for each, so only the label event posts.
  const notifyWorkflow = fs.readFileSync('.github/workflows/discord-notify.yml', 'utf8');
  assert.match(notifyWorkflow, /issues:\s*\n\s*types: \[labeled\]/, 'issues notify on labels only');
  assert.doesNotMatch(notifyWorkflow, /action == 'opened'/);
  assert.match(notifyWorkflow, /I_LABEL: \$\{\{ github\.event\.label\.name \}\}/);
  assert.match(notifyWorkflow, /\["bug", "enhancement", "question"\]/, 'a labelled issue posts a notice');

  // Ideas and questions are GitHub discussions, each category with its own form; the issue chooser
  // sends them there, and a new discussion posts one notice named after its category.
  assert.match(fs.readFileSync('.github/DISCUSSION_TEMPLATE/ideas.yml', 'utf8'), /labels: \["enhancement"\]/, 'ideas have their own form');
  assert.match(fs.readFileSync('.github/DISCUSSION_TEMPLATE/q-a.yml', 'utf8'), /labels: \["question"\]/, 'and questions too');
  assert.ok(!fs.existsSync('.github/ISSUE_TEMPLATE/feature_request.yml') && !fs.existsSync('.github/ISSUE_TEMPLATE/question.yml'),
    'neither is an issue form any more');
  const chooser = fs.readFileSync('.github/ISSUE_TEMPLATE/config.yml', 'utf8');
  assert.match(chooser, /discussions\/new\?category=ideas/);
  assert.match(chooser, /discussions\/new\?category=q-a/);
  assert.match(notifyWorkflow, /discussion:\s*\n\s*types: \[created\]/, 'a new discussion posts a notice');
  assert.match(notifyWorkflow, /D_CATEGORY: \$\{\{ github\.event\.discussion\.category\.name \}\}/);
  assert.match(notifyWorkflow, /tools\/discord-notification\.mjs discussion --send/);
  const discussion = (extra) => run('discussion', { D_URL: 'https://github.com/thomasthanos/nexusmods-bypass/discussions/1', D_USER: 'someone', ...extra }).embeds[0];
  const idea = discussion({ D_TITLE: '[Idea] Dark mode', D_CATEGORY: 'Ideas' });
  assert.equal(idea.title, 'GitHub · Idea: [Idea] Dark mode');
  assert.equal(idea.description, 'Started by someone in Ideas. Open the discussion to reply.');
  assert.equal(idea.url, 'https://github.com/thomasthanos/nexusmods-bypass/discussions/1');
  assert.equal(idea.color, 0x3498db);
  assert.equal(discussion({ D_TITLE: '[Question] Does it work with MO2?', D_CATEGORY: 'Q&A' }).title, 'GitHub · Question: [Question] Does it work with MO2?');
  assert.equal(discussion({ D_TITLE: 'Hello', D_CATEGORY: 'General' }).title, 'GitHub · Discussion: Hello', 'any other category is a plain discussion');

  // A release published with the workflow's token starts no other workflow, so discord-notify never
  // heard of 3.1.6 or 3.1.7: the publish job announces its own release. Its title comes from the notes.
  const publish = fs.readFileSync('.github/workflows/publish-release.yml', 'utf8');
  assert.doesNotMatch(publish, /API reliability and collection fixes/, 'no release title is hard-coded');
  assert.match(publish, /--title "\$\{\{ steps\.version\.outputs\.title \}\}"|--title "\$TITLE"/);
  assert.match(publish, /node tools\/discord-notification\.mjs release --send/);
  fs.writeFileSync(summary, 'x'.repeat(7000));
  assert.ok(run('schema').embeds[0].description.length <= 3900);
  // Release notes full of emoji are cut between characters, never inside one.
  fs.writeFileSync(summary, `${'x'.repeat(3898)}🚀🚀🚀`);
  const cut = run('schema').embeds[0].description;
  assert.equal(cut, cut.toWellFormed(), 'no half emoji reaches Discord');
  // A link Discord would refuse is left out rather than losing the whole notice.
  assert.equal(run('manifest', { LINK: 'javascript:alert(1)' }).embeds[0].url, undefined);

  // --send: a missing secret is a quiet skip; an unusable one is a warning, never a failed job and
  // never echoed.
  const send = (extra) => spawnSync(process.execPath, ['tools/discord-notification.mjs', 'schema', summary, '--send'], {
    encoding: 'utf8', env: { ...process.env, DISCORD_WEBHOOK_URL: '', ...extra }
  });
  const skipped = send({});
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /not set; skipping/);
  const refused = send({ DISCORD_WEBHOOK_URL: 'http://discord.invalid/api/webhooks/1/SECRET-TOKEN' });
  assert.equal(refused.status, 0, 'a failed post does not fail the workflow');
  assert.match(refused.stdout, /^::warning::Discord notification not delivered: invalid webhook URL/m);
  assert.doesNotMatch(refused.stdout + refused.stderr, /SECRET-TOKEN/);
  const bad = spawnSync(process.execPath, ['tools/discord-notification.mjs', 'nonsense'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'a workflow typo still fails loudly');

  // In process: Discord's 429 is waited out through the shared dispatcher.
  const replies = [
    new Response(JSON.stringify({ retry_after: 2 }), { status: 429 }),
    new Response(JSON.stringify({ id: '1' }), { status: 200 })
  ];
  const waits = [];
  const delivered = await sendGithubMessage(githubMessage('release', { R_NAME: '9.9.9', R_URL: 'https://github.com/x' }), {
    webhookUrl: 'https://discord.invalid/api/webhooks/1/token',
    fetchImpl: async () => replies.shift(),
    sleep: async (ms) => { waits.push(ms); },
    random: () => 0
  });
  assert.equal(delivered.ok, true);
  assert.deepEqual(waits, [2000]);
  console.log('Discord GitHub formatting OK: distinct source, colours, safe mentions and bounded payloads.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
