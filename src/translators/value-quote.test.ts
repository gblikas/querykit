/**
 * Value quoting.
 *
 * A single quote inside a string value is doubled, and a double quote and a
 * backslash stay inside the single-quoted literal, on inline SQL; the other
 * engines bind the string. A value that also holds U+0000 cannot be written
 * into statement text, since SQLite stops reading at the zero byte, so
 * inline SQL splits the string there and joins the quoted pieces with
 * `CHAR(0)`. Every engine then returns the same row.
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

const ZERO = '\u0000';

const rows = [
  { id: 1, status: `a'b`, note: 'x' },
  { id: 2, status: `a"b`, note: 'x' },
  { id: 3, status: 'x', note: 'a\\b' },
  { id: 4, status: `a'b"c\\d`, note: 'x' },
  { id: 5, status: 'a', note: 'x' },
  { id: 6, status: `a'${ZERO}"b\\c`, note: 'x' },
  { id: 7, status: `a'`, note: 'x' },
  { id: 8, status: `a'"b\\c`, note: 'x' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  note: text('note')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, note TEXT)'
  );
  const insert = database.prepare('INSERT INTO items VALUES (?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.status, row.note);
  }
  return database;
}

describe('value quoting', () => {
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

  /** Every engine must agree on the ids; returns the compiled forms. */
  function runEverywhere(
    query: string,
    expectedIds: number[]
  ): {
    expression: QueryExpression;
    inlineSql: string;
    parameterized: IParameterizedSql;
    drizzle: IParameterizedSql;
    schemaDrizzle: IParameterizedSql;
  } {
    const expression = parser.parse(query);
    const inlineSql = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    const bare = compileDrizzle(expression);
    const schemaDrizzle = compileDrizzle(expression, { items });
    expect(idsOfSql({ sql: inlineSql, params: [] })).toEqual(expectedIds);
    expect(idsOfSql(parameterized)).toEqual(expectedIds);
    expect(idsOfSql(bare)).toEqual(expectedIds);
    expect(idsOfSql(schemaDrizzle)).toEqual(expectedIds);
    expect(idsOfBuilder(expression)).toEqual(expectedIds);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(expectedIds);
    return {
      expression,
      inlineSql,
      parameterized,
      drizzle: bare,
      schemaDrizzle
    };
  }

  it.each([
    [`status:"a'b"`, 'status', `a'b`, `"status" = 'a''b'`, [1]],
    [`status:"a\\"b"`, 'status', `a"b`, `"status" = 'a"b'`, [2]],
    [`note:"a\\\\b"`, 'note', 'a\\b', `"note" = 'a\\b'`, [3]],
    [
      `status:"a'b\\"c\\\\d"`,
      'status',
      `a'b"c\\d`,
      `"status" = 'a''b"c\\d'`,
      [4]
    ]
  ])(
    '%s keeps quotes and backslashes inside the literal',
    (query, field, value, inlineSql, expectedIds) => {
      const run = runEverywhere(query, expectedIds);
      expect(run.expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value
      });
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({
        sql: `"${field}" = ?`,
        params: [value]
      });
      expect(run.drizzle).toEqual({ sql: `"${field}" = ?`, params: [value] });
      expect(run.schemaDrizzle).toEqual({
        sql: `"items"."${field}" = ?`,
        params: [value]
      });
    }
  );

  it('writes a zero byte inside an inline equality as CHAR(0)', () => {
    const value = `a'${ZERO}"b\\c`;
    const run = runEverywhere(`status:"a'${ZERO}\\"b\\\\c"`, [6]);
    expect(run.expression).toEqual({
      type: 'comparison',
      field: 'status',
      operator: '==',
      value
    });
    expect(run.inlineSql).toBe(`"status" = ('a''' || CHAR(0) || '"b\\c')`);
    expect(run.inlineSql).not.toContain(ZERO);
    expect(run.parameterized).toEqual({ sql: '"status" = ?', params: [value] });
    expect(run.drizzle).toEqual({ sql: '"status" = ?', params: [value] });
  });

  it('writes a zero byte inside an inline membership member as CHAR(0)', () => {
    const value = `a'${ZERO}"b\\c`;
    const run = runEverywhere(`status:in["a'${ZERO}\\"b\\\\c"]`, [6]);
    expect(run.expression).toEqual({
      type: 'comparison',
      field: 'status',
      operator: 'IN',
      value: [value]
    });
    expect(run.inlineSql).toBe(`"status" IN (('a''' || CHAR(0) || '"b\\c'))`);
    expect(run.parameterized).toEqual({
      sql: '"status" IN (?)',
      params: [value]
    });
    expect(run.drizzle).toEqual({ sql: '"status" in (?)', params: [value] });
  });
});
