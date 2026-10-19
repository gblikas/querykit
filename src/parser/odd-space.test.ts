/**
 * Non-breaking space between tokens.
 *
 * Liqe's whitespace is tab, line feed, vertical tab, form feed and a normal
 * space; U+00A0 is a value character. The search box used JavaScript `\s`,
 * which dropped it, so `status:\u00a0open` looked incomplete while `parse`
 * accepted it, and `status:open\u00a0AND\u00a0priority:1` looked complete
 * while `parse` threw. No form is rewritten.
 */

import { createRequire } from 'module';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { parseQueryInput } from './tokenizer';
import { QueryExpression } from './types';
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
  { id: 1, status: 'open', priority: 1 },
  { id: 2, status: '\u00a0open', priority: 1 },
  { id: 3, status: 'open\tclosed', priority: 2 }
];

describe('non-breaking space', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const Database = nodeRequire('better-sqlite3') as new (
    file: string
  ) => ISqliteDatabase;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, priority INTEGER)'
  );
  for (const row of rows) {
    database
      .prepare('INSERT INTO items (id, status, priority) VALUES (?, ?, ?)')
      .run(row.id, row.status, row.priority);
  }

  afterAll((): void => {
    database.close();
  });

  function engineIds(expression: QueryExpression, query: string): number[][] {
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator({ useParameters: true }).translate(
      expression
    ) as { sql: string; params: unknown[] };
    const drizzle = dialect.sqlToQuery(
      new DrizzleTranslator().translate(expression)
    );
    const idsOf = (sql: string, params: unknown[]): number[] =>
      database
        .prepare(`SELECT id FROM items WHERE ${sql} ORDER BY id`)
        .all(...params)
        .map(row => row.id);
    return [
      idsOf(inline, []),
      idsOf(parameterized.sql, parameterized.params),
      idsOf(drizzle.sql, drizzle.params),
      filterInMemory(query, rows).map(row => row.id)
    ];
  }

  it.each(['status:\topen', 'status:\nopen'])(
    'keeps %p incomplete with the empty-tag error',
    query => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(
        'Invalid field or expression in Tag node'
      );
    }
  );

  it('keeps a tab-separated AND complete and agreed', () => {
    const query = 'status:open\tAND\tpriority:1';
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`("status" = 'open') AND ("priority" = 1)`);
    expect(engineIds(expression, query)).toEqual([[1], [1], [1], [1]]);
  });

  it('keeps a quoted tab inside the value', () => {
    const query = 'status:"open\tclosed"';
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ value: 'open\tclosed' });
    expect(engineIds(expression, query)).toEqual([[3], [3], [3], [3]]);
  });

  it('keeps U+00A0 after the colon inside the value', () => {
    const query = 'status:\u00a0open';
    expect(parseQueryInput(query).terms[0]).toMatchObject({
      key: 'status',
      value: '\u00a0open'
    });
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: '\u00a0open'
    });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"status" = '\u00a0open'`);
    expect(engineIds(expression, query)).toEqual([[2], [2], [2], [2]]);
  });

  it.each([
    [
      'status:open\u00a0AND\u00a0priority:1',
      'Syntax error at line 1 column 25'
    ],
    ['\u00a0status:open', 'Syntax error at line 1 column 8']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });
});
