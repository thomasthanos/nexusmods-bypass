// Discord notices for GitHub workflows. Formats the message and, with --send, posts it through the
// dispatcher the report relay uses (relay/discord.js): Discord's rate limits are waited out, gateway
// errors are retried with backoff, and a failed post is a workflow warning, never a failed job. The
// webhook comes from DISCORD_WEBHOOK_URL and is never printed or put on a command line.
//   node tools/discord-notification.mjs <release|issue|discussion|manifest|schema> [summary.md]          print it
//   node tools/discord-notification.mjs <release|issue|discussion|manifest|schema> [summary.md] --send   post it
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { COLORS, clip, quiet, fitEmbed, postWebhook } from '../relay/discord.js';

const compact = (value) => quiet(value)
  .replace(/<\/?(?:p|img|details|summary|br)\b[^>]*>/gi, '')
  .replace(/^\s*#{1,6}\s+(.+)$/gm, '**$1**')
  .replace(/\n{3,}/g, '\n\n').trim();

// Discord refuses the whole message over an embed URL that is not http(s).
const linkOf = (value) => (/^https?:\/\/\S+$/i.test(String(value || '')) ? String(value) : '');

export function githubMessage(kind, input) {
  let title, description, url, color;
  if (kind === 'release') {
    title = `GitHub · Release ${input.R_NAME || ''}`;
    description = compact(input.R_BODY || 'A new release is available.');
    url = input.R_URL;
    color = COLORS.success;
  } else if (kind === 'issue') {
    // The label says what was filed; a "[Feature Request]" title filed through the bug form is still
    // a request (issue #29 came in as "Bug issue").
    const issueTitle = String(input.I_TITLE || '');
    const [kindName, kindNoun] = input.I_LABEL === 'question' || /^\s*\[question\]/i.test(issueTitle) ? ['Question', 'question']
      : input.I_LABEL === 'enhancement' || /^\s*\[(?:feature(?: request)?|request|idea|suggestion)\]/i.test(issueTitle) ? ['Feature request', 'request']
        : ['Bug issue', 'report'];
    title = `GitHub · ${kindName}: ${issueTitle || 'New issue'}`;
    description = `Opened by ${quiet(input.I_USER || 'a user')}. Open the issue for the full ${kindNoun}.`;
    url = input.I_URL;
    color = COLORS.notice;
  } else if (kind === 'discussion') {
    // Ideas and questions are GitHub discussions; the category says which.
    const category = String(input.D_CATEGORY || '');
    const kindName = /\bq\s*&\s*a\b|question/i.test(category) ? 'Question' : /idea|suggest/i.test(category) ? 'Idea' : 'Discussion';
    title = `GitHub · ${kindName}: ${input.D_TITLE || 'New discussion'}`;
    description = `Started by ${quiet(input.D_USER || 'a user')} in ${quiet(category || 'Discussions')}. Open the discussion to reply.`;
    url = input.D_URL;
    color = COLORS.notice;
  } else if (kind === 'manifest' || kind === 'schema') {
    title = kind === 'manifest' ? `GitHub · Permissions: ${input.TITLE || 'Manifest update'}` : 'GitHub · Nexus API schema warning';
    description = compact(input.summary || 'The check could not finish. Open the workflow log for details.');
    url = input.LINK || input.RUN_URL;
    color = kind === 'schema' || input.EXPANDED === 'true' || input.INCOMPLETE === 'true' ? COLORS.warning : COLORS.notice;
  } else {
    throw new Error('Unsupported notification kind');
  }
  const link = linkOf(url);
  return {
    username: 'NexusMods Bypass · GitHub',
    allowed_mentions: { parse: [] },
    embeds: [fitEmbed({
      title: clip(quiet(String(title).split(/\r?\n/)[0]), 256),
      description: clip(description, 3900),
      ...(link ? { url: link } : {}),
      color,
      footer: { text: 'Repository automation · not a user error' }
    })]
  };
}

// A workflow has minutes to spare, so it waits out longer limits than the relay can.
export async function sendGithubMessage(message, { webhookUrl = process.env.DISCORD_WEBHOOK_URL, ...options } = {}) {
  if (!webhookUrl) return { skipped: true };
  return postWebhook(webhookUrl, message, { maxAttempts: 5, budgetMs: 60000, timeoutMs: 15000, ...options });
}

async function main(args) {
  const send = args.includes('--send');
  const [kind, summaryFile] = args.filter((arg) => arg !== '--send');
  const summary = summaryFile ? fs.readFileSync(summaryFile, 'utf8') : '';
  const message = githubMessage(kind, { ...process.env, summary });
  if (!send) {
    console.log(JSON.stringify(message));
    return;
  }
  const result = await sendGithubMessage(message);
  if (result.skipped) console.log('DISCORD_WEBHOOK_URL not set; skipping.');
  else if (result.ok) console.log(`Discord notification sent (${result.attempts} attempt${result.attempts === 1 ? '' : 's'}).`);
  else console.log(`::warning::Discord notification not delivered: ${result.error} after ${result.attempts} attempt(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
