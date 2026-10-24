import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

test('Store/Analytics migration upgrades existing D1 schema without changing old records and is repeatable', (t) => {
  const canonical = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/0001_store_analytics.sql', import.meta.url), 'utf8');
  const boundary = canonical.indexOf('-- Additive: safe to apply');
  assert.ok(boundary > 0); assert.equal(canonical.slice(boundary).trim(), migration.trim());
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(canonical.slice(0, boundary));
  const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  db.exec(migration); db.exec(migration);
  for (const row of before) assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(row.name).sql, row.sql);
  for (const name of ['analytics_cache','store_monitor_state','store_reviews','store_review_deliveries']) {
    assert.equal(db.prepare('PRAGMA table_list').all().find((row) => row.name === name)?.strict,1,name);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
