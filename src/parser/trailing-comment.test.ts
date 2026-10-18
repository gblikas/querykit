/**
 * Trailing comment.
 *
 * `status:open # note` and `status:open // note` are extra implicit-field
 * tags to Liqe, and `status:open -- note` is a syntax error. None is a
 * second clause, none is stripped down to `status:open`, and the search box
 * is incomplete for all three.
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

const rows = [
  { id: 1, status: 'open' },
  { id: 2, status: 'done' }
];

const IMPLICIT_FIELD =
  'Implicit field search is not supported; queries must name a field';

describe('trailing comment', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const Database = nodeRequire('better-sqlite3') as new (
    file: string
  ) => ISqliteDatabase;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT)');
  for (const row of rows) {
    database
      .prepare('INSERT INTO items (id, status) VALUES (?, ?)')
      .run(row.id, row.status);
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
    ['status:open # note', IMPLICIT_FIELD],
    ['status:open // note', IMPLICIT_FIELD],
    ['status:open -- note', 'Syntax error at line 1 column 15'],
    ['-- note', 'Syntax error at line 1 column'],
    ['status:open\t--note', 'Syntax error at line 1 column']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it('keeps status:open complete and agreed on every engine', () => {
    expect(isInputComplete('status:open')).toBe(true);
    const expression = parser.parse('status:open');
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator({ useParameters: true }).translate(
      expression
    ) as { sql: string; params: unknown[] };
    const drizzle = dialect.sqlToQuery(
      new DrizzleTranslator().translate(expression)
    );
    expect(inline).toBe(`"status" = 'open'`);
    expect(parameterized).toEqual({ sql: '"status" = ?', params: ['open'] });
    expect(drizzle).toMatchObject({ sql: '"status" = ?', params: ['open'] });
    expect(idsOf(inline, [])).toEqual([1]);
    expect(idsOf(parameterized.sql, parameterized.params)).toEqual([1]);
    expect(idsOf(drizzle.sql, drizzle.params)).toEqual([1]);
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([1]);
  });

  it.each([
    ['status:open--note', 'open--note'],
    ['status:"open -- note"', 'open -- note']
  ])('keeps %p as the value %p', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: '==', value });
    expect(filterInMemory(query, rows)).toEqual([]);
  });

  it('keeps a regex of two minuses a regex', () => {
    expect(isInputComplete('name:/--/')).toBe(true);
    expect(parser.parse('name:/--/')).toMatchObject({
      operator: 'REGEX',
      value: '/--/'
    });
  });
});
