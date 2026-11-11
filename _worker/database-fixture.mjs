import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function testDatabase(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  function statement(sql, args = []) {
    return {
      sql,
      bind: (...parameters) => statement(sql, parameters),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: () => ({ results: db.prepare(sql).all(...args) }),
      run: () => ({ meta: db.prepare(sql).run(...args) }),
    };
  }
  const binding = {
    prepare: statement,
    batch: async statements => {
      db.exec('BEGIN');
      try {
        const results = statements.map(statement => /^\s*SELECT\b/i.test(statement.sql) ? statement.all() : statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, binding };
}
