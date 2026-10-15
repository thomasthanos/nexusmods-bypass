// Discord notices for GitHub workflows. Formats the message and, with --send, posts it through the
// dispatcher the report relay uses (relay/discord.js): Discord's rate limits are waited out, gateway
// errors are retried with backoff, and a failed post is a workflow warning, never a failed job. The
// webhook comes from DISCORD_WEBHOOK_URL and is never printed or put on a command line.
//   node tools/discord-notification.mjs <release|issue|manifest|schema> [summary.md]          print it
//   node tools/discord-notification.mjs <release|issue|manifest|schema> [summary.md] --send   post it
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
    title = `GitHub · Bug issue: ${input.I_TITLE || 'New issue'}`;
    description = `Opened by ${quiet(input.I_USER || 'a user')}. Open the issue for the full report.`;
    url = input.I_URL;
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
