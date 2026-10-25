// Writes ../tests/fixtures/report-schemas.json: the JSON Schema of the reports this Worker accepts, exported
// from the Zod schemas in src/schemas/ingest.ts, so the extension's and the relay's own tests can check
// what they build without loading this package. Checks JSON Schema cannot express (no NUL characters, the
// reserved installation id, the payload budget) stay in Zod. Run after changing those schemas:
//   node tools/export-report-schemas.mjs
// test/report-schemas.test.mjs fails while the committed file is out of date.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { errorReportSchema, relayedReportSchema } from '../src/schemas/ingest.ts';

export const OUTPUT = new URL('../../tests/fixtures/report-schemas.json', import.meta.url);

export function exportedSchemas() {
  // What a client may send: optional fields with defaults stay optional.
  const options = { io: 'input', unrepresentable: 'any' };
  const schemas = {
    errorReport: z.toJSONSchema(errorReportSchema, options),
    relayedReport: z.toJSONSchema(relayedReportSchema, options)
  };
  return `${JSON.stringify(schemas, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUTPUT, exportedSchemas());
  console.log('Wrote tests/fixtures/report-schemas.json');
}
