/**
 * Bare word.
 *
 * An unquoted literal with no field is Liqe's implicit-field tag, which
 * QueryKit rejects: there is no full-text field. The search box used to call
 * `open` and `open done` complete while `parse` threw. Neither is rewritten
 * into a field query.
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
  'Failed to parse query: Implicit field search is not supported; queries must name a field';

describe('bare word', () => {
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

  it.each(['open', 'open done'])(
    'treats %p as incomplete and rejected on every engine',
    query => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => parser.parse(query)).toThrow(IMPLICIT_FIELD);
      expect(() => filterInMemory(query, rows)).toThrow(IMPLICIT_FIELD);
    }
  );

  it('keeps status:open complete and agreed on every engine', () => {
    expect(isInputComplete('status:open')).toBe(true);
    const expression = parser.parse('status:open');
    expect(expression).toEqual({
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: 'open'
    });
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
    expect(idsOf(inline, [])).toEqual([1]);
    expect(idsOf(parameterized.sql, parameterized.params)).toEqual([1]);
    expect(idsOf(drizzle.sql, drizzle.params)).toEqual([1]);
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([1]);
  });

  it('keeps an empty quoted field name as a field', () => {
    expect(isInputComplete('"":a')).toBe(true);
    expect(parser.parse('"":a')).toEqual({
      type: 'comparison',
      field: '',
      operator: '==',
      value: 'a'
    });
    expect(
      filterInMemory('"":a', [
        { id: 1, '': 'a' },
        { id: 2, '': 'b' }
      ]).map(row => row.id)
    ).toEqual([1]);
  });

  it('keeps lowercase and between field clauses an operator', () => {
    expect(isInputComplete('status:active and name:test')).toBe(true);
    expect(parser.parse('status:active and name:test').type).toBe('logical');
  });

  it.each([
    'note:"open done"',
    'id:[2 TO 5]',
    'status:[open, done]',
    'not:disabled'
  ])('keeps %p complete and parseable', query => {
    expect(isInputComplete(query)).toBe(true);
    expect(() => parser.parse(query)).not.toThrow();
  });

  it.each(['status :a', ':a', ':', 'status:', '"hello world"'])(
    'keeps %p incomplete and rejected',
    query => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(QueryParseError);
    }
  );
});
