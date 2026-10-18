/**
 * A string ordered against a boolean.
 *
 * SQLite with no affinity orders null, then numbers, then text, and stores a
 * boolean as 1 or 0, so every string is greater than both booleans.
 * `label:>true` inlines `TRUE` and keeps every text row; `flag:>"m"` binds
 * the text `m` on every engine, including a boolean-mode Drizzle column,
 * whose encoder would otherwise turn `m` into `1` inside the ordered
 * operators.
 *
 * In memory every string is greater than every boolean.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { isInputComplete } from '../parser/input-parser';
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

const rows: Array<{ id: number; label: string; flag: boolean | null }> = [
  { id: 1, label: 'a', flag: true },
  { id: 2, label: 'z', flag: false },
  { id: 3, label: '', flag: null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  label: text('label'),
  flag: integer('flag', { mode: 'boolean' })
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label, flag)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.label, row.flag === null ? null : row.flag ? 1 : 0);
  }
  return database;
}

const cases: Array<
  [string, string, string, string, unknown[], string, number[]]
> = [
  [
    'label:>true',
    'label',
    '>',
    '"label" > true',
    [],
    '"label" > TRUE',
    [1, 2, 3]
  ],
  [
    'label:<=false',
    'label',
    '<=',
    '"label" <= false',
    [],
    '"label" <= FALSE',
    []
  ],
  ['flag:>"m"', 'flag', '>', `"flag" > 'm'`, ['m'], '"flag" > ?', []],
  ['flag:<"m"', 'flag', '<', `"flag" < 'm'`, ['m'], '"flag" < ?', [1, 2]]
];

describe('a string ordered against a boolean', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const db = drizzle(database as never);

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

  function idsOfBuilder(expression: QueryExpression): number[] {
    const condition = new DrizzleTranslator({ schema: { items } }).translate(
      expression,
      { tableName: 'items' }
    );
    return db
      .select({ id: items.id })
      .from(items)
      .where(condition)
      .orderBy(items.id)
      .all()
      .map(row => row.id as number);
  }

  it.each(cases)(
    '%s binds text as text and inlines a boolean on every SQL engine',
    (query, field, operator, inlineSql, params, parameterizedSql, ids) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toMatchObject({ type: 'comparison', field, operator });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const bare = compileDrizzle(expression);
      const schemaDrizzle = compileDrizzle(expression, { items });
      expect(inline).toBe(inlineSql);
      expect(parameterized).toEqual({ sql: parameterizedSql, params });
      expect(bare).toEqual({ sql: parameterizedSql, params });
      expect(schemaDrizzle).toEqual({
        sql: parameterizedSql.replace(`"${field}"`, `"items"."${field}"`),
        params
      });
      expect(idsOfSql({ sql: inline, params: [] })).toEqual(ids);
      expect(idsOfSql(parameterized)).toEqual(ids);
      expect(idsOfSql(bare)).toEqual(ids);
      expect(idsOfSql(schemaDrizzle)).toEqual(ids);
      expect(idsOfBuilder(expression)).toEqual(ids);
    }
  );

  // Every string, including the empty string, is greater than every boolean,
  // in either direction.
  describe('in memory', () => {
    it.each(cases)('%s matches the SQL engines', (query, ...rest) => {
      const ids = rest[rest.length - 1] as number[];
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
    });
  });
});
