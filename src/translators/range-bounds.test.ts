/**
 * Range bounds across the engines.
 *
 * `field:[a TO b]` is rewritten to `>= a AND <= b`, `*` drops a side, a
 * blank side is rejected and swapped bounds match nothing. Two strings
 * compare by Unicode code point, which is SQLite's binary order, so a range
 * whose bounds cross from the basic multilingual plane into a supplementary
 * character (`U+FFFF` to `😀`) keeps both ends in memory as well.
 */

import { createRequire } from 'module';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { QueryParseError } from '../parser/parser';
import { QueryExpression } from '../parser/types';
import { DrizzleTranslator } from './drizzle';
import { SqlTranslator } from './sql';

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
  run(...params: unknown[]): unknown;
}

interface ISqliteDatabase {
  exec(sqlText: string): void;
  prepare(sqlText: string): ISqliteStatement;
  close(): void;
}

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

interface IParameterizedSql {
  sql: string;
  params: unknown[];
}

const rows: Array<{
  id: number;
  priority: number | null;
  label: string | null;
}> = [
  { id: 1, priority: 1, label: '\uFFFF' },
  { id: 2, priority: 2, label: '😀' },
  { id: 3, priority: 0, label: 'a' },
  { id: 4, priority: 11, label: '🚀' },
  { id: 5, priority: null, label: null },
  { id: 6, priority: 10, label: 'm' },
  { id: 7, priority: -1, label: 'b' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  priority: integer('priority'),
  label: text('label')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, priority INTEGER, label TEXT)'
  );
  const insert = database.prepare('INSERT INTO items VALUES (?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.priority, row.label);
  }
  return database;
}

describe('range bounds', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(statement: IParameterizedSql): number[] {
    return database
      .prepare(`SELECT id FROM items WHERE ${statement.sql} ORDER BY id`)
      .all(...statement.params)
      .map(row => row.id);
  }

  function compileDrizzle(
    expression: QueryExpression,
    schema?: Record<string, Record<string, unknown>>
  ): IParameterizedSql {
    const translator = new DrizzleTranslator(schema ? { schema } : {});
    const compiled = dialect.sqlToQuery(translator.translate(expression));
    return { sql: compiled.sql, params: compiled.params };
  }

  /** Every engine must return the same ids for the query. */
  function expectIds(query: string, expectedIds: number[]): void {
    const expression = parser.parse(query);
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
    expect(idsOfSql(parameterized)).toEqual(expectedIds);
    expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
    expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual(
      expectedIds
    );
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(expectedIds);
  }

  it('keeps an inclusive numeric range and matches nothing when swapped', () => {
    expect(parser.parse('priority:[1 TO 10]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: { type: 'comparison', field: 'priority', operator: '>=', value: 1 },
      right: {
        type: 'comparison',
        field: 'priority',
        operator: '<=',
        value: 10
      }
    });
    expectIds('priority:[1 TO 10]', [1, 2, 6]);
    expectIds('priority:[10 TO 1]', []);
    expectIds('label:[m TO b]', []);
  });

  it.each(['priority:[ TO 10]', 'priority:[1 TO ]', 'label:[ TO m]'])(
    'rejects the blank side of %s',
    query => {
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    }
  );

  it('drops the side written as *', () => {
    expect(parser.parse('priority:[* TO 10]')).toEqual({
      type: 'comparison',
      field: 'priority',
      operator: '<=',
      value: 10
    });
    expectIds('priority:[* TO 10]', [1, 2, 3, 6, 7]);
    expectIds('priority:[1 TO *]', [1, 2, 4, 6]);
  });

  it('orders strings by code point across the supplementary plane', () => {
    expect(parser.parse('label:[* TO 😀]')).toEqual({
      type: 'comparison',
      field: 'label',
      operator: '<=',
      value: '😀'
    });
    expectIds('label:[* TO 😀]', [1, 2, 3, 6, 7]);
    expectIds('label:[\uFFFF TO 😀]', [1, 2]);
  });
});
