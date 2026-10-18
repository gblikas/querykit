/**
 * Odd numerals.
 *
 * Liqe's decimal is an optional minus and digits with one optional fraction,
 * so `08`, `09` and `02` are numbers whose leading zero collapses. A hex,
 * binary or octal prefix and digits split by an underscore are syntax
 * errors; the search box is incomplete for them and the parser is not
 * taught to read them.
 */

import { createRequire } from 'module';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
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
  { id: 1, count: 8 },
  { id: 2, count: 9 },
  { id: 3, count: 16 },
  { id: 4, count: 10 },
  { id: 5, count: '0x10' },
  { id: 6, count: 2 }
];

describe('odd numerals', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
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

  function idsOf(sql: string, params: unknown[]): number[] {
    return database
      .prepare(`SELECT id FROM items WHERE ${sql} ORDER BY id`)
      .all(...params)
      .map(row => row.id);
  }

  it.each([
    ['count:08', 8, `"count" = 8`, [1]],
    ['count:09', 9, `"count" = 9`, [2]],
    ['count:02', 2, `"count" = 2`, [6]],
    ['count:"0x10"', '0x10', `"count" = '0x10'`, [5]]
  ])('keeps %p complete with value %p', (query, value, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ operator: '==', value });
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator({ useParameters: true }).translate(
      expression
    ) as { sql: string; params: unknown[] };
    const drizzle = dialect.sqlToQuery(
      new DrizzleTranslator().translate(expression)
    );
    expect(inline).toBe(sql);
    expect(parameterized).toEqual({ sql: '"count" = ?', params: [value] });
    expect(idsOf(inline, [])).toEqual(ids);
    expect(idsOf(parameterized.sql, parameterized.params)).toEqual(ids);
    expect(idsOf(drizzle.sql, drizzle.params)).toEqual(ids);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each(['count:0x10', 'count:1_0', 'count:0b10', 'count:0o10'])(
    'treats %p as incomplete and rejected',
    query => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => parser.parse(query)).toThrow(
        'Syntax error at line 1 column 8'
      );
      expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    }
  );
});
