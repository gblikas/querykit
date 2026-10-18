/**
 * Depth and clause caps on every engine.
 *
 * A chain of 11 comparisons (depth 10) and a balanced tree of 50
 * comparisons run everywhere. One more comparison on either shape is
 * rejected with the validator's `QuerySecurityError` before any SQL is
 * built or any row is read, on inline SQL, parameterized SQL, the Drizzle
 * translator and the Drizzle adapter, as `createQueryKit` already did.
 * Raised caps still run the larger query. A server exclusion is appended
 * after the checks, so a query at either cap still runs with one.
 *
 * The in-memory assertions land with layer 5 (in-memory compare and sort);
 * the kit forwarding raised caps, and raising them by one per injected
 * exclusion, lands with layer 6.
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
import { inMemoryAdapter } from '../adapters/memory';
import { createQueryKit } from '../index';
import { IComparisonExpression, QueryExpression } from '../parser/types';
import { DrizzleTranslator } from '../translators/drizzle';
import { ITranslationContext } from '../translators/types';
import { SqlTranslator } from '../translators/sql';
import { QuerySecurityError } from './validator';

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

const DEPTH_MESSAGE = 'Query exceeds maximum depth of 10';
const CLAUSE_MESSAGE = 'Query exceeds maximum clause count of 50 (found 51)';

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

const rows = [{ id: 1, label: 1, status: 'shown' }];

const items = sqliteTable('items', {
  id: integer('id'),
  label: integer('label'),
  status: text('status')
});

function comparison(): IComparisonExpression {
  return { type: 'comparison', field: 'label', operator: '==', value: 1 };
}

/** `count` comparisons joined left to right: depth `count - 1`. */
function buildComparisonChain(count: number): QueryExpression {
  let expression: QueryExpression = comparison();
  for (let i = 1; i < count; i += 1) {
    expression = {
      type: 'logical',
      operator: 'AND',
      left: expression,
      right: comparison()
    };
  }
  return expression;
}

/** The query string the kit parses back into the same tree. */
function toQueryString(expression: QueryExpression): string {
  if (expression.type !== 'logical' || !expression.right) {
    return 'label:1';
  }
  return `(${toQueryString(expression.left)}) AND (${toQueryString(
    expression.right
  )})`;
}

/** `count` comparisons in a balanced AND tree: depth `ceil(log2(count))`. */
function buildBalancedTree(count: number): QueryExpression {
  if (count <= 1) {
    return comparison();
  }
  const half = Math.floor(count / 2);
  return {
    type: 'logical',
    operator: 'AND',
    left: buildBalancedTree(half),
    right: buildBalancedTree(count - half)
  };
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, label INTEGER, status TEXT);
    INSERT INTO items VALUES (1, 1, 'shown');
  `);
  return database;
}

describe('depth and clause caps', () => {
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
    context?: ITranslationContext
  ): IParameterizedSql {
    const compiled = dialect.sqlToQuery(
      translator.translate(expression, context)
    );
    return { sql: compiled.sql, params: compiled.params };
  }

  async function idsEverywhere(
    expression: QueryExpression,
    options: ITranslationContext = {}
  ): Promise<number[][]> {
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
      { ...options }
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
    ['the depth cap', buildComparisonChain(11)],
    ['the clause cap', buildBalancedTree(50)]
  ])('runs a query at %s on every engine', async (_name, expression) => {
    for (const ids of await idsEverywhere(expression)) {
      expect(ids).toEqual([1]);
    }
    expect(logged).toHaveLength(1);
  });

  it.each([
    ['the depth cap', buildComparisonChain(12), DEPTH_MESSAGE],
    ['the clause cap', buildBalancedTree(51), CLAUSE_MESSAGE]
  ])(
    'rejects a query one step past %s before rows are read',
    async (_name, expression, message) => {
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
      await expect(adapter.execute('items', expression)).rejects.toThrow(
        message
      );
      expect(logged).toHaveLength(0);
      for (const kitAdapter of [
        adapter,
        inMemoryAdapter({ records: { items: rows } })
      ]) {
        const kit = createQueryKit({ adapter: kitAdapter, schema: { items } });
        await expect(
          kit.query('items').where(toQueryString(expression)).execute()
        ).rejects.toThrow(message);
      }
      expect(logged).toHaveLength(0);
    }
  );

  it.each([
    ['depth', buildComparisonChain(12), { maxQueryDepth: 11 }],
    ['clause count', buildBalancedTree(51), { maxClauseCount: 51 }]
  ])(
    'still runs one step past the default %s when the cap is raised on the engine',
    async (_name, expression, options) => {
      for (const ids of await idsEverywhere(expression, options)) {
        expect(ids).toEqual([1]);
      }
    }
  );

  it('still runs a query at each cap when an engine appends an exclusion', async () => {
    const options = { enforceExcludedValues: { status: ['hidden'] } };
    for (const expression of [
      buildComparisonChain(11),
      buildBalancedTree(50)
    ]) {
      for (const ids of await idsEverywhere(expression, options)) {
        expect(ids).toEqual([1]);
      }
    }
    expect(logged[0]).toContain('"items"."status" not in (?)');
  });

  // Layer 6 (kit forwarding): createQueryKit passes the resolved caps into
  // adapter.execute, raised by one per injected exclusion.
  describe.skip('through the kit (layer 6)', () => {
    it.each([
      ['depth', buildComparisonChain(12), { maxQueryDepth: 11 }],
      ['clause count', buildBalancedTree(51), { maxClauseCount: 51 }]
    ])(
      'still runs one step past the default %s when the cap is raised',
      async (_name, expression, security) => {
        for (const kitAdapter of [
          adapter,
          inMemoryAdapter({ records: { items: rows } })
        ]) {
          const kit = createQueryKit({
            adapter: kitAdapter,
            schema: { items },
            security
          });
          const matched = await kit
            .query('items')
            .where(toQueryString(expression))
            .execute();
          expect(idsOf(matched)).toEqual([1]);
        }
      }
    );

    it('still runs a query at each cap when an exclusion is injected', async () => {
      for (const kitAdapter of [
        adapter,
        inMemoryAdapter({ records: { items: rows } })
      ]) {
        const kit = createQueryKit({
          adapter: kitAdapter,
          schema: { items },
          security: { enforceExcludedValues: { status: ['hidden'] } }
        });
        for (const expression of [
          buildComparisonChain(11),
          buildBalancedTree(50)
        ]) {
          const matched = await kit
            .query('items')
            .where(toQueryString(expression))
            .execute();
          expect(idsOf(matched)).toEqual([1]);
        }
      }
    });
  });

  // Layer 5 (in-memory compare and sort): the in-memory adapter checks the
  // caps before it walks the table and honours raised caps on its options.
  describe.skip('in memory (layer 5)', () => {
    it.each([
      [buildComparisonChain(12), DEPTH_MESSAGE, { maxQueryDepth: 11 }],
      [buildBalancedTree(51), CLAUSE_MESSAGE, { maxClauseCount: 51 }]
    ])('rejects before rows are read', async (expression, message, raised) => {
      const memory = inMemoryAdapter({ records: { items: rows } });
      await expect(memory.execute('items', expression)).rejects.toThrow(
        message
      );
      const matched = await memory.execute<{ id: number }>(
        'items',
        expression,
        raised
      );
      expect(matched.map(row => row.id)).toEqual([1]);
    });
  });
});
