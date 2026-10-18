/**
 * String value length on every engine.
 *
 * A 1000-character string matches; a 1001-character string, alone or as a
 * membership member, is rejected with the validator's `QuerySecurityError`
 * before any SQL is built or any row is read, on inline SQL, parameterized
 * SQL, the Drizzle translator and the Drizzle adapter, as `createQueryKit`
 * already did. A raised `maxValueLength` still matches it.
 *
 * The in-memory adapter checks the cap before it walks the table, and
 * `createQueryKit` forwards a raised cap into the adapter.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { filterInMemory, inMemoryAdapter } from '../adapters/memory';
import { filterByExpression } from '../adapters/memory/match-expression';
import { createQueryKit } from '../index';
import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { QuerySecurityError } from './validator';

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

const AT_CAP = 'a'.repeat(1000);
const OVER_CAP = 'a'.repeat(1001);
const EQUALITY_MESSAGE =
  'Query contains a string value that exceeds maximum length of 1000 characters';
const MEMBERSHIP_MESSAGE =
  'Query contains a string value in array that exceeds maximum length of 1000 characters';

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

const rows = [
  { id: 1, label: AT_CAP },
  { id: 2, label: OVER_CAP }
];

const items = sqliteTable('items', {
  id: integer('id'),
  label: text('label')
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
  const insert = database.prepare('INSERT INTO items VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.label);
  }
  return database;
}

describe('string value length', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();
  const logged: string[] = [];
  const db = drizzle(database as never, {
    logger: { logQuery: (query: string): number => logged.push(query) }
  });
  const adapter = new DrizzleAdapter({ db, schema: { items } });

  beforeEach((): void => {
    logged.length = 0;
  });

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
    translator: DrizzleTranslator,
    context?: { maxValueLength?: number }
  ): IParameterizedSql {
    const compiled = dialect.sqlToQuery(
      translator.translate(expression, context)
    );
    return { sql: compiled.sql, params: compiled.params };
  }

  async function idsEverywhere(
    expression: QueryExpression,
    maxValueLength?: number
  ): Promise<number[][]> {
    const options = maxValueLength === undefined ? {} : { maxValueLength };
    const inline = new SqlTranslator({
      useParameters: false,
      ...options
    }).translate(expression) as string;
    const parameterized = new SqlTranslator(options).translate(
      expression
    ) as IParameterizedSql;
    const executed = await adapter.execute<{ id: number }>(
      'items',
      expression,
      options
    );
    return [
      idsOfSql({ sql: inline, params: [] }),
      idsOfSql(parameterized),
      idsOfSql(compileDrizzle(expression, new DrizzleTranslator(options))),
      idsOfSql(compileDrizzle(expression, new DrizzleTranslator(), options)),
      executed.map(row => row.id)
    ];
  }

  it.each([
    [`label:"${AT_CAP}"`, 'a 1000-character string'],
    [
      `label:in["${AT_CAP}"]`,
      'a membership list that holds a 1000-character string'
    ]
  ])('matches %s (%s) on every engine', async query => {
    const expression = parser.parse(query);
    for (const ids of await idsEverywhere(expression)) {
      expect(ids).toEqual([1]);
    }
    expect(logged).toHaveLength(1);
  });

  it.each([
    [`label:"${OVER_CAP}"`, EQUALITY_MESSAGE],
    [`label:in["${OVER_CAP}"]`, MEMBERSHIP_MESSAGE]
  ])('rejects %s before any engine reads a row', async (query, message) => {
    const expression = parser.parse(query);
    expect(() =>
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toThrow(QuerySecurityError);
    expect(() => new SqlTranslator().translate(expression)).toThrow(message);
    expect(() => new DrizzleTranslator().translate(expression)).toThrow(
      QuerySecurityError
    );
    expect(() => new DrizzleTranslator().translate(expression)).toThrow(
      message
    );
    await expect(adapter.execute('items', expression)).rejects.toThrow(
      QuerySecurityError
    );
    await expect(adapter.execute('items', expression)).rejects.toThrow(message);
    expect(logged).toHaveLength(0);
    for (const kitAdapter of [
      adapter,
      inMemoryAdapter({ records: { items: rows } })
    ]) {
      const kit = createQueryKit({ adapter: kitAdapter, schema: { items } });
      await expect(kit.query('items').where(query).execute()).rejects.toThrow(
        message
      );
    }
    expect(logged).toHaveLength(0);
  });

  it.each([`label:"${OVER_CAP}"`, `label:in["${OVER_CAP}"]`])(
    'still matches %s when maxValueLength is raised on the engine',
    async query => {
      const expression = parser.parse(query);
      for (const ids of await idsEverywhere(expression, 1001)) {
        expect(ids).toEqual([2]);
      }
    }
  );

  // createQueryKit passes the resolved cap into adapter.execute, so a raised
  // cap is not forced back to 1000 by the adapter's own check.
  describe('through the kit', () => {
    it.each([`label:"${OVER_CAP}"`, `label:in["${OVER_CAP}"]`])(
      'still matches %s when maxValueLength is raised',
      async query => {
        for (const kitAdapter of [
          adapter,
          inMemoryAdapter({ records: { items: rows } })
        ]) {
          const kit = createQueryKit({
            adapter: kitAdapter,
            schema: { items },
            security: { maxValueLength: 1001 }
          });
          const matched = await kit.query('items').where(query).execute();
          expect(idsOf(matched)).toEqual([2]);
        }
      }
    );
  });

  // The in-memory adapter checks the cap before it walks the table and
  // honours a raised cap on its options, as do the direct functions.
  describe('in memory', () => {
    it.each([
      [`label:"${OVER_CAP}"`, EQUALITY_MESSAGE],
      [`label:in["${OVER_CAP}"]`, MEMBERSHIP_MESSAGE]
    ])('rejects %s before rows are read', async (query, message) => {
      const memory = inMemoryAdapter({ records: { items: rows } });
      await expect(
        memory.execute('items', parser.parse(query))
      ).rejects.toThrow(message);
      expect(() => filterByExpression(parser.parse(query), rows)).toThrow(
        message
      );
      expect(() => filterInMemory(query, rows)).toThrow(message);
      const raised = await memory.execute<{ id: number }>(
        'items',
        parser.parse(query),
        { maxValueLength: 1001 }
      );
      expect(raised.map(row => row.id)).toEqual([2]);
      expect(
        filterInMemory(query, rows, undefined, { maxValueLength: 1001 }).map(
          row => row.id
        )
      ).toEqual([2]);
    });
  });
});
