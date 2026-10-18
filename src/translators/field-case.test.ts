/**
 * A field name in another letter case.
 *
 * SQLite resolves the quoted identifiers `"Status"` and `"STATUS"` to the
 * column `status`. The in-memory reader does the same: an exact own key
 * wins, otherwise the one own key differing only by ASCII case is read. The
 * AST field and the SQL identifier stay as written; a row that holds both
 * spellings answers each exactly, and an ambiguous third spelling nothing.
 */

import { createRequire } from 'module';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { filterByExpression } from '../adapters/memory/match-expression';
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

const rows: Array<{ id: number; status: string | null }> = [
  { id: 1, status: 'open' },
  { id: 2, status: 'closed' },
  { id: 3, status: null },
  { id: 4, status: 'Open' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.status);
  }
  return database;
}

describe('a field name in another letter case', () => {
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

  it.each(['status:open', 'Status:open', 'STATUS:open'])(
    '%s reads the stored column on every engine',
    query => {
      const expression = parser.parse(query);
      const field = query.split(':')[0];
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value: 'open'
      });
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const bare = compileDrizzle(expression);
      expect(inline).toBe(`"${field}" = 'open'`);
      expect(parameterized).toEqual({
        sql: `"${field}" = ?`,
        params: ['open']
      });
      expect(bare).toEqual({ sql: `"${field}" = ?`, params: ['open'] });
      expect(idsOfSql({ sql: inline, params: [] })).toEqual([1]);
      expect(idsOfSql(parameterized)).toEqual([1]);
      expect(idsOfSql(bare)).toEqual([1]);
      expect(idsOfSql(compileDrizzle(expression, { items }))).toEqual([1]);
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual([1]);
    }
  );

  it('reads an exact own key first and nothing for an ambiguous spelling', () => {
    const twoSpellings = [
      { id: 1, status: 'open', Status: 'closed' },
      { id: 2, status: 'closed', Status: 'open' }
    ];
    expect(filterInMemory('status:open', twoSpellings).map(r => r.id)).toEqual([
      1
    ]);
    expect(filterInMemory('Status:open', twoSpellings).map(r => r.id)).toEqual([
      2
    ]);
    expect(filterInMemory('STATUS:open', twoSpellings)).toEqual([]);
  });

  it('does not fold letters outside ASCII', () => {
    const greek = [{ id: 1, σtatus: 'open' }];
    const equals = (field: string): QueryExpression => ({
      type: 'comparison',
      field,
      operator: '==',
      value: 'open'
    });
    expect(filterByExpression(equals('σtatus'), greek).map(r => r.id)).toEqual([
      1
    ]);
    expect(filterByExpression(equals('Σtatus'), greek)).toEqual([]);
  });
});
