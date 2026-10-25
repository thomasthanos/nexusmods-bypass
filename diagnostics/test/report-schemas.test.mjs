import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { exportedSchemas, OUTPUT } from '../tools/export-report-schemas.mjs';

// The extension's and the relay's tests check what they build against this export, so it has to follow
// every change to src/schemas/ingest.ts.
test('the committed report JSON Schema is what the Zod schemas export today', () => {
  assert.equal(readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n'), exportedSchemas(),
    'tests/fixtures/report-schemas.json is out of date: run node tools/export-report-schemas.mjs in diagnostics/');
});
