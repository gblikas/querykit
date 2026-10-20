/**
 * Broken numerals.
 *
 * A finished exponent, a leading plus, a leading dot and a trailing dot are
 * spelled into Liqe's decimal before parsing. An exponent with no digits, a
 * sign or dot with no digits, and a second dot are not, so they are syntax
 * errors and the search box is incomplete for them.
 */

import { createRequire } from 'module';
import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const nodeRequire = createRequire(__filename);

interface ISqliteDatabase {
  exec(sqlText: string): void;
  prepare(sqlText: string): {
    all(...params: unknown[]): Array<{ id: number }>;
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

const rows: Array<{ id: number; count: number | string }> = [
  { id: 1, count: 1 },
  { id: 2, count: '1e' },
  { id: 3, count: 2 }
];

describe('broken numerals', () => {
  const parser = new QueryParser();
  const Database = nodeRequire('better-sqlite3') as new (
    file: string
  ) => ISqliteDatabase;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, count)');
  for (const row of rows) {
    database
      .prepare('INSERT INTO items (id, count) VALUES (?, ?)')
      .run(row.id, row.count);
  }

  afterAll((): void => {
    database.close();
  });

  it.each([
    ['count:1', 1, [1]],
    ['count:+1', 1, [1]],
    ['count:1.', 1, [1]],
    ['count:02', 2, [3]],
    ['count:"1e"', '1e', [2]],
    ['count:1e2', 100, []],
    ['count:1e+2', 100, []],
    ['count:1e-1', 0.1, []],
    ['count:.5', 0.5, []],
    ['count:1.2', 1.2, []]
  ])('keeps %p complete with value %p', (query, value, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ operator: '==', value });
    const parameterized = new SqlTranslator({ useParameters: true }).translate(
      expression
    ) as { sql: string; params: unknown[] };
    const bound =
      typeof value === 'number'
        ? `("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = ?)`
        : '"count" = ?';
    expect(parameterized).toEqual({ sql: bound, params: [value] });
    expect(
      database
        .prepare(`SELECT id FROM items WHERE ${parameterized.sql} ORDER BY id`)
        .all(...parameterized.params)
        .map(row => row.id)
    ).toEqual(ids);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each([
    ['count:1e', 'Syntax error at line 1 column 8'],
    ['count:1e+', 'Syntax error at line 1 column 8'],
    ['count:1e-', 'Syntax error at line 1 column 8'],
    ['count:1E', 'Syntax error at line 1 column 8'],
    ['count:+', 'Syntax error at line 1 column 7'],
    ['count:.', 'Syntax error at line 1 column 7'],
    ['count:1.2.3', 'Syntax error at line 1 column 10'],
    ['count:0x10', 'Syntax error at line 1 column 8']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });
});
