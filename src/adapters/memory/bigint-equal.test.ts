/**
 * Equality with an integer past the safe range.
 *
 * `count:9007199254740993` (2^53 + 1) is read from the source digits as a
 * bigint, so no engine compares the rounded neighbour 2^53. Inline SQL
 * writes the digits, parameterized SQL and Drizzle bind the bigint, and the
 * row holding the exact value is the only match. `count:1` is unchanged.
 *
 * The in-memory assertions land with layer 5 (in-memory compare and sort),
 * where a bigint field equals a finite number of the same value.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect
} from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { isInputComplete } from '../../parser/input-parser';
import { QueryExpression } from '../../parser/types';
import { DrizzleTranslator } from '../../translators/drizzle';
import { SqlTranslator } from '../../translators/sql';
import { filterInMemory } from './filter-in-memory';

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

const rows: Array<{ id: number; count: bigint | number }> = [
  { id: 1, count: 9007199254740993n },
  { id: 2, count: 9007199254740992n },
  { id: 3, count: 1n },
  { id: 4, count: 1 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: integer('count')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, count INTEGER)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.count);
  }
  return database;
}

const cases: Array<[string, bigint | number, string, number[]]> = [
  ['count:9007199254740993', 9007199254740993n, '9007199254740993', [1]],
  ['count:1', 1, '1', [3, 4]]
];

describe('equality with an integer past the safe range', () => {
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
    '%s keeps the exact integer on every SQL engine',
    (query, value, digits, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'count',
        operator: '==',
        value
      });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const bare = compileDrizzle(expression);
      const schemaDrizzle = compileDrizzle(expression, { items });
      expect(inline).toBe(`"count" = ${digits}`);
      expect(parameterized).toEqual({ sql: '"count" = ?', params: [value] });
      expect(bare).toEqual({ sql: '"count" = ?', params: [value] });
      expect(schemaDrizzle).toEqual({
        sql: '"items"."count" = ?',
        params: [value]
      });
      expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(parameterized)).toEqual(expectedIds);
      expect(idsOfSql(bare)).toEqual(expectedIds);
      expect(idsOfSql(schemaDrizzle)).toEqual(expectedIds);
      expect(idsOfBuilder(expression)).toEqual(expectedIds);
    }
  );

  it('still rejects a hand-built safe bigint inline and binds it as a parameter', () => {
    const expression: QueryExpression = {
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: 10n
    };
    expect(() =>
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toThrow('Unsupported value type: bigint');
    expect(new SqlTranslator().translate(expression)).toEqual({
      sql: '"count" = ?',
      params: [10n]
    });
  });

  // Layer 5 (in-memory compare and sort): a bigint field equals a finite
  // number of the same value, so `count:1` keeps the `1n` row as well.
  describe.skip('in memory (layer 5)', () => {
    it.each(cases)('%s matches the SQL engines', (query, _value, _d, ids) => {
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
    });
  });
});
