// Validates every GraphQL operation the extension sends (QUERIES in src/content/nexus-api.js) against
// the live Nexus Mods v2 schema, which Nexus publishes through open introspection. A field Nexus
// removes or renames shows up here before users hit it.
//   node tools/schema-watch.mjs            live schema
//   node tools/schema-watch.mjs --snapshot use tools/fixtures/nexus-v2-schema.json (offline)
//   node tools/schema-watch.mjs --update   live schema, and refresh the snapshot
// Writes a Markdown summary to $SCHEMA_WATCH_SUMMARY when set.
import fs from 'node:fs';
import vm from 'node:vm';
import { buildClientSchema, getIntrospectionQuery, parse, validate } from 'graphql';

const SNAPSHOT = 'tools/fixtures/nexus-v2-schema.json';
const ENDPOINT = 'https://api.nexusmods.com/v2/graphql';
const args = new Set(process.argv.slice(2));

function loadQueries() {
  const ctx = vm.createContext({});
  ctx.window = ctx;
  ctx.NexusExt = ctx.window.NexusExt = {};
  vm.runInContext(fs.readFileSync('src/content/nexus-api.js', 'utf8'), ctx);
  return ctx.window.NexusExt.NexusApi.QUERIES;
}

async function liveIntrospection() {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: getIntrospectionQuery({ descriptions: false }) })
  });
  if (!response.ok) throw new Error(`introspection HTTP ${response.status}`);
  const json = await response.json();
  if (!json?.data?.__schema) throw new Error(`introspection returned no schema: ${JSON.stringify(json?.errors || '').slice(0, 300)}`);
  return json.data;
}

const introspection = args.has('--snapshot') ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : await liveIntrospection();
if (args.has('--update')) fs.writeFileSync(SNAPSHOT, JSON.stringify(introspection));

const schema = buildClientSchema(introspection);
const failures = [];
const queries = loadQueries();
for (const [name, query] of Object.entries(queries)) {
  for (const error of validate(schema, parse(query))) failures.push(`${name}: ${error.message}`);
}

const lines = [`### Nexus GraphQL schema watch (${args.has('--snapshot') ? 'snapshot' : 'live'})`, ''];
lines.push(failures.length
  ? `❌ ${failures.length} problem(s) in ${Object.keys(queries).length} operations:\n\n${failures.map((f) => `- ${f}`).join('\n')}`
  : `✅ All ${Object.keys(queries).length} operations are valid against the current schema.`);
const summary = lines.join('\n');
if (process.env.SCHEMA_WATCH_SUMMARY) fs.writeFileSync(process.env.SCHEMA_WATCH_SUMMARY, `${summary}\n`);
console.log(summary);
process.exit(failures.length ? 1 : 0);
