// The report contract every side checks. tests/fixtures/relay-reports.json holds one report of each kind
// the extension sends the relay; tests/fixtures/report-schemas.json is the JSON Schema of what the
// diagnostics Worker accepts, exported from its Zod schemas by workers/diagnostics/tools/export-report-schemas.mjs.
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8'));

export const reports = read('relay-reports.json');

// Zod writes a regular expression next to each format it emits, so the formats need no checker here.
const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
const validators = Object.fromEntries(Object.entries(read('report-schemas.json'))
  .map(([name, schema]) => [name, ajv.compile(schema)]));

// The ways `value` breaks the named schema, or [] when it fits.
export function schemaErrors(name, value) {
  const validate = validators[name];
  if (!validate) throw new Error(`no report schema named ${name}`);
  return validate(value) ? [] : validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`);
}
