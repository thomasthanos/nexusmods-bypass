import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// A test database that closes when the test ends.
export function testDatabase(t) {
  const db = createTestDatabase();
  t.after(() => db.close());
  return db;
}

// Exercise production SQL against SQLite; only the D1 method boundary is adapted.
export function createTestDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8'));

  function prepare(sql, values = []) {
    function execute() {
      const results = sqlite.prepare(sql).all(...values).map((row) => ({ ...row }));
      const meta = sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get();
      return { success: true, results, meta: { ...meta, duration: 0, rows_read: results.length, rows_written: meta.changes } };
    }
    return {
      bind(...nextValues) { return prepare(sql, nextValues); },
      async first(column) {
        const row = execute().results[0] ?? null;
        return column && row ? row[column] : row;
      },
      async all() { return execute(); },
      async run() { return execute(); },
      async raw() { return execute().results.map((row) => Object.values(row)); },
      execute
    };
  }

  return {
    sqlite,
    prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    close() { sqlite.close(); }
  };
}
