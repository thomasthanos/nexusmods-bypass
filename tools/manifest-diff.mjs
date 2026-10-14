// Compares two manifest.json files (base vs head) on what matters for users and store review:
// permissions, host permissions, optional permissions, content-script matches, CSP and the Firefox
// settings. Writes a Markdown summary and prints a JSON verdict for CI.
//   node tools/manifest-diff.mjs <base.json> <head.json> [summary.md]
import fs from 'node:fs';

const KEYS = ['permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions'];
// Additions here trigger a new permission warning on update.
const WARNING_KEYS = new Set(['permissions', 'host_permissions']);

const read = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
};
const set = (value) => new Set(Array.isArray(value) ? value.map(String) : []);
const matchesOf = (m) => set((m.content_scripts || []).flatMap((s) => s.matches || []));
const cspOf = (m) => JSON.stringify(m.content_security_policy ?? null);

export function diffManifests(base, head) {
  const checked = [base, head].every((m) => m && typeof m === 'object' && typeof m.version === 'string' && /^\d+(?:\.\d+){1,3}$/.test(m.version));
  if (!checked) return { checked: false, changes: [], expanded: false, versions: [base?.version || '?', head?.version || '?'] };
  const changes = [];
  const compare = (label, a, b, warns) => {
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) changes.push({ label, added, removed, warns: warns && added.length > 0 });
  };
  for (const key of KEYS) compare(key, set(base[key]), set(head[key]), WARNING_KEYS.has(key));
  compare('content_scripts.matches', matchesOf(base), matchesOf(head), true);
  if (cspOf(base) !== cspOf(head)) changes.push({ label: 'content_security_policy', added: [cspOf(head)], removed: [cspOf(base)], warns: true });
  const gecko = (m) => JSON.stringify(m.browser_specific_settings ?? null);
  if (gecko(base) !== gecko(head)) changes.push({ label: 'browser_specific_settings', added: [gecko(head)], removed: [gecko(base)], warns: false });
  return { checked: true, changes, expanded: changes.some((c) => c.warns), versions: [base.version, head.version] };
}

export function summarize(result) {
  if (result.checked === false) return '### Manifest permission check unavailable\n\nPermissions could not be checked: one or both manifests are missing or invalid. No conclusion about permission changes is available.';
  const lines = [`### Manifest permission check (${result.versions[0]} → ${result.versions[1]})`, ''];
  if (!result.changes.length) {
    lines.push('No changes to permissions, host permissions, content-script matches or CSP.');
    return lines.join('\n');
  }
  lines.push(result.expanded
    ? '⚠️ **This change expands what the extension can access.** Users may see a new permission prompt on update and store review may take longer.'
    : 'ℹ️ Changes found, none of which add an install-time permission warning.');
  lines.push('', '| Field | Added | Removed |', '|---|---|---|');
  for (const c of result.changes) {
    const fmt = (list) => (list.length ? list.map((x) => `\`${x.replace(/\|/g, '\\|')}\``).join('<br>') : '—');
    lines.push(`| ${c.warns ? '⚠️ ' : ''}${c.label} | ${fmt(c.added)} | ${fmt(c.removed)} |`);
  }
  return lines.join('\n');
}

// Discord does not render Markdown tables or HTML line breaks.
export function summarizeDiscord(result) {
  if (result.checked === false) return '**Permission check unavailable**\nOne or both manifests are missing or invalid. Permission changes could not be checked.';
  const lines = [`**Permissions · ${result.versions[0]} → ${result.versions[1]}**`];
  if (!result.changes.length) return `${lines[0]}\nNo permission changes.`;
  lines.push(result.expanded ? '⚠️ Access expanded — review required.' : 'ℹ️ No new install-time permission warning.');
  for (const change of result.changes) {
    lines.push(`\n**${change.label}**`);
    if (change.added.length) lines.push(`• Added: ${change.added.map((v) => `\`${v.replace(/`/g, '')}\``).join(', ')}`);
    if (change.removed.length) lines.push(`• Removed: ${change.removed.map((v) => `\`${v.replace(/`/g, '')}\``).join(', ')}`);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const [baseFile, headFile, out, discordOut] = process.argv.slice(2);
  const result = diffManifests(read(baseFile), read(headFile));
  const md = summarize(result);
  if (out) fs.writeFileSync(out, `${md}\n`);
  if (discordOut) fs.writeFileSync(discordOut, `${summarizeDiscord(result)}\n`);
  console.log(JSON.stringify({ checked: result.checked, changed: !result.checked || result.changes.length > 0, expanded: result.expanded }));
}
