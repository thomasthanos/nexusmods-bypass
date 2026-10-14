// Payload-only formatter for GitHub workflows. Never reads a webhook or sends a request.
import fs from 'node:fs';

const clip = (value, length) => String(value || '').slice(0, length);
const quiet = (value) => String(value || '').replace(/@/g, '@\u200b');
const compact = (value) => quiet(value)
  .replace(/<\/?(?:p|img|details|summary|br)\b[^>]*>/gi, '')
  .replace(/^\s*#{1,6}\s+(.+)$/gm, '**$1**')
  .replace(/\n{3,}/g, '\n\n').trim();

export function githubMessage(kind, input) {
  let title, description, url, color;
  if (kind === 'release') {
    title = `GitHub · Release ${input.R_NAME || ''}`;
    description = compact(input.R_BODY || 'A new release is available.');
    url = input.R_URL;
    color = 0x57f287;
  } else if (kind === 'issue') {
    title = `GitHub · Bug issue: ${input.I_TITLE || 'New issue'}`;
    description = `Opened by ${quiet(input.I_USER || 'a user')}. Open the issue for the full report.`;
    url = input.I_URL;
    color = 0x3498db;
  } else if (kind === 'manifest' || kind === 'schema') {
    title = kind === 'manifest' ? `GitHub · Permissions: ${input.TITLE || 'Manifest update'}` : 'GitHub · Nexus API schema warning';
    description = compact(input.summary || 'The check could not finish. Open the workflow log for details.');
    url = input.LINK || input.RUN_URL;
    color = kind === 'schema' || input.EXPANDED === 'true' || input.INCOMPLETE === 'true' ? 0xe8b339 : 0x3498db;
  } else {
    throw new Error('Unsupported notification kind');
  }
  return {
    username: 'NexusMods Bypass · GitHub',
    allowed_mentions: { parse: [] },
    embeds: [{ title: clip(quiet(title.split(/\r?\n/)[0]), 256), description: clip(description, 3900), ...(url ? { url } : {}), color, footer: { text: 'Repository automation · not a user error' } }]
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const [kind, summaryFile] = process.argv.slice(2);
  const summary = summaryFile ? fs.readFileSync(summaryFile, 'utf8') : '';
  console.log(JSON.stringify(githubMessage(kind, { ...process.env, summary })));
}
