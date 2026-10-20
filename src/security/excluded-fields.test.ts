/**
 * Excluded field values on every engine.
 *
 * `enforceExcludedValues: { secret: [1] }` appends the same comparison as
 * `secret:!=1`. Inline SQL compares the number by storage class.
 * `createQueryKit` already injected it; inline SQL, parameterized SQL, the
 * Drizzle translator and the Drizzle adapter now apply the same comparison
 * when they are given the map, after the allowlist and complexity checks,
 * and return the kit's ids. An omitted or empty map injects nothing.
 *
 * The in-memory adapter, `filterByExpression` and `filterInMemory` append
 * the comparison before the row loop when their options carry the map.
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

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
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

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

const rows = [
  { id: 1, status: 'open', secret: 0 },
  { id: 2, status: 'closed', secret: 1 },
  { id: 3, status: 'open', secret: 1 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  secret: integer('secret')
});

const enforceExcludedValues = { secret: [1] };

const excludedNumber = `NOT (("secret" IS NULL AND NULL) OR (typeof("secret") IN ('integer', 'real') AND "secret" = 1))`;

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, secret INTEGER);
    INSERT INTO items VALUES (1, 'open', 0), (2, 'closed', 1), (3, 'open', 1);
  `);
  return database;
}

const cases: Array<[string, string, number[], number[]]> = [
  ['status:open', `("status" = 'open') AND (${excludedNumber})`, [1], [1, 3]],
  [
    'secret:1',
    `(("secret" IS NULL AND NULL) OR (typeof("secret") IN ('integer', 'real') AND "secret" = 1)) AND (${excludedNumber})`,
    [],
    [2, 3]
  ],
  [
    'status:open OR secret:1',
    `(("status" = 'open') OR (("secret" IS NULL AND NULL) OR (typeof("secret") IN ('integer', 'real') AND "secret" = 1))) AND (${excludedNumber})`,
    [1],
    [1, 2, 3]
  ]
];

describe('excluded field values', () => {
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
    context?: { enforceExcludedValues?: Record<string, number[]> }
  ): IParameterizedSql {
    const compiled = dialect.sqlToQuery(
      translator.translate(expression, context)
    );
    return { sql: compiled.sql, params: compiled.params };
  }

  it.each(cases)(
    '%s applies the exclusion on every engine',
    async (query, inlineSql, expectedIds, unfilteredIds) => {
      const expression = parser.parse(query);
      const inline = new SqlTranslator({
        useParameters: false,
        enforceExcludedValues
      }).translate(expression) as string;
      const parameterized = new SqlTranslator({
        enforceExcludedValues
      }).translate(expression) as IParameterizedSql;
      expect(inline).toBe(inlineSql);
      expect(parameterized.params[parameterized.params.length - 1]).toBe(1);
      expect(idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
      expect(idsOfSql(parameterized)).toEqual(expectedIds);
      expect(
        idsOfSql(
          compileDrizzle(
            expression,
            new DrizzleTranslator({ enforceExcludedValues })
          )
        )
      ).toEqual(expectedIds);
      expect(
        idsOfSql(
          compileDrizzle(expression, new DrizzleTranslator(), {
            enforceExcludedValues
          })
        )
      ).toEqual(expectedIds);
      const executed = await adapter.execute<{ id: number }>(
        'items',
        expression,
        { enforceExcludedValues }
      );
      expect(executed.map(row => row.id)).toEqual(expectedIds);
      expect(logged[0]).toContain(
        `NOT (("items"."secret" IS NULL AND NULL) OR (typeof("items"."secret") IN ('integer', 'real') AND "items"."secret" = ?))`
      );
      for (const kitAdapter of [
        adapter,
        inMemoryAdapter({ records: { items: rows } })
      ]) {
        const kit = createQueryKit({
          adapter: kitAdapter,
          schema: { items },
          security: { enforceExcludedValues }
        });
        const matched = await kit.query('items').where(query).execute();
        expect(idsOf(matched)).toEqual(expectedIds);
      }
      // Without the map the same engines read the unfiltered rows.
      expect(
        idsOfSql(new SqlTranslator().translate(expression) as IParameterizedSql)
      ).toEqual(unfilteredIds);
      expect(
        idsOfSql(
          compileDrizzle(expression, new DrizzleTranslator(), {
            enforceExcludedValues: {}
          })
        )
      ).toEqual(unfilteredIds);
    }
  );

  describe('in memory', () => {
    it.each(cases)('%s applies the exclusion', async (query, _sql, ids) => {
      const memory = inMemoryAdapter({ records: { items: rows } });
      const matched = await memory.execute<{ id: number }>(
        'items',
        parser.parse(query),
        { enforceExcludedValues }
      );
      expect(matched.map(row => row.id)).toEqual(ids);
      expect(
        filterByExpression(parser.parse(query), rows, {
          enforceExcludedValues
        }).map(row => row.id)
      ).toEqual(ids);
      expect(
        filterInMemory(query, rows, undefined, { enforceExcludedValues }).map(
          row => row.id
        )
      ).toEqual(ids);
    });
  });
});
