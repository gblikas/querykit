/**
 * A string ordered against a number, and a number against a string.
 *
 * SQLite with no affinity orders every number below every text value, so
 * `label:>2` keeps every string including the empty one, `label:<10` keeps
 * none, `count:>"2"` keeps none and `count:<"10"` keeps every number. Memory
 * applies the same class order instead of treating the pair as unordered.
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

const rows: Array<{ id: number; label: string | null; count: number | null }> =
  [
    { id: 1, label: '10', count: null },
    { id: 2, label: '2', count: null },
    { id: 3, label: 'a', count: null },
    { id: 4, label: '', count: null },
    { id: 5, label: null, count: 1 },
    { id: 6, label: null, count: 2 },
    { id: 7, label: null, count: 10 }
  ];

const items = sqliteTable('items', {
  id: integer('id'),
  label: text('label'),
  count: integer('count')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label, count)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.label, row.count);
  }
  return database;
}

describe('a string ordered against a number', () => {
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

  it.each([
    ['label:>2', 'label', '>', 2, [1, 2, 3, 4]],
    ['label:<10', 'label', '<', 10, []],
    ['count:>"2"', 'count', '>', '2', []],
    ['count:<"10"', 'count', '<', '10', [5, 6, 7]]
  ])(
    '%s puts every string above every number on every engine',
    (query, field, operator, value, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator,
        value
      });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const schemaDrizzle = compileDrizzle(expression, { items });
      expect(parameterized.params).toEqual([value]);
      expect(schemaDrizzle.params).toEqual([value]);
      expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(parameterized)).toEqual(expectedIds);
      expect(idsOfSql(compileDrizzle(expression))).toEqual(expectedIds);
      expect(idsOfSql(schemaDrizzle)).toEqual(expectedIds);
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(
        expectedIds
      );
    }
  );
});
