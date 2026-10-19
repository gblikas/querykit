/**
 * `caseInsensitiveFields` with `fieldMappings`, filtered and sorted on.
 *
 * With `caseInsensitiveFields: true` and `{ a: 'status' }`, every filter on
 * `a`, `A` or `status` resolves to the column `status` on inline SQL,
 * parameterized SQL, Drizzle and in memory, and so does every sort key:
 * `createQueryKit` folds a sort key before it renames it through the
 * mapping, the way the parser treats a comparison field, so `orderBy('A')`
 * orders by `status` instead of reaching SQLite as `"A"` and tying every
 * row in memory. Value case is never folded. The map is placed on the
 * parser and, separately, on the adapters.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from './adapters/drizzle';
import { inMemoryAdapter } from './adapters/memory';
import { createQueryKit, QueryKit } from './index';
import { QueryParser } from './parser';
import { IParserOptions } from './parser/types';
import { SqlTranslator } from './translators/sql';

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

interface IItem {
  id: number;
  status: string | null;
}

interface IPlacement {
  parserOptions: IParserOptions;
  translatorMappings: Record<string, string> | undefined;
  kits: Array<QueryKit<Schema>>;
}

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status')
});

/** The kit's schema declares the alias so the adapter placement passes its check. */
const kitSchema = { items: { id: {}, a: {}, status: {} } };

type Schema = typeof kitSchema;

const fieldMappings = { a: 'status' };

const rows: IItem[] = [
  { id: 1, status: 'open' },
  { id: 2, status: 'Open' },
  { id: 3, status: 'OPEN' },
  { id: 4, status: 'closed' },
  { id: 5, status: 'öpen' },
  { id: 6, status: null }
];

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT);
    INSERT INTO items VALUES
      (1, 'open'), (2, 'Open'), (3, 'OPEN'), (4, 'closed'), (5, 'öpen'), (6, NULL);
  `);
  return database;
}

const filters: Array<[string, number[]]> = [
  ['a:open', [1]],
  ['A:open', [1]],
  ['a:OPEN', [3]],
  ['status:Open', [2]],
  ['a:op*', [1, 2, 3]],
  ['a:[OPEN, closed]', [3, 4]],
  ['a:in [OPEN, closed]', [3, 4]],
  ['a:>M', [1, 2, 3, 4, 5]]
];

const sorts: Array<[string, 'asc' | 'desc', number[]]> = [
  ['a', 'asc', [6, 3, 2, 4, 1, 5]],
  ['a', 'desc', [5, 1, 4, 2, 3, 6]],
  ['A', 'asc', [6, 3, 2, 4, 1, 5]],
  ['A', 'desc', [5, 1, 4, 2, 3, 6]]
];

describe('a folded field name with a mapping', () => {
  const database = openDatabase();
  const db = drizzle(database as never);

  const placements: Array<[string, IPlacement]> = [
    [
      'on the parser',
      {
        parserOptions: { caseInsensitiveFields: true, fieldMappings },
        translatorMappings: undefined,
        kits: [
          createQueryKit({
            adapter: new DrizzleAdapter({ db, schema: { items } }),
            schema: kitSchema,
            parserOptions: { caseInsensitiveFields: true, fieldMappings }
          }),
          createQueryKit({
            adapter: inMemoryAdapter({ records: { items: rows } }),
            schema: kitSchema,
            parserOptions: { caseInsensitiveFields: true, fieldMappings }
          })
        ]
      }
    ],
    [
      'on the adapters',
      {
        parserOptions: { caseInsensitiveFields: true },
        translatorMappings: fieldMappings,
        kits: [
          createQueryKit({
            adapter: new DrizzleAdapter({
              db,
              schema: { items },
              fieldMappings
            }),
            schema: kitSchema,
            parserOptions: { caseInsensitiveFields: true }
          }),
          createQueryKit({
            adapter: inMemoryAdapter({
              records: { items: rows },
              fieldMappings
            }),
            schema: kitSchema,
            parserOptions: { caseInsensitiveFields: true }
          })
        ]
      }
    ]
  ];

  function idsOfSql(statement: string, params: unknown[] = []): number[] {
    return database
      .prepare(`SELECT id FROM items WHERE ${statement}`)
      .all(...params)
      .map(row => row.id);
  }

  afterAll((): void => {
    database.close();
  });

  describe.each(placements)('with the map %s', (_name, placement) => {
    const parser = new QueryParser(placement.parserOptions);
    const inlineTranslator = new SqlTranslator({
      useParameters: false,
      fieldMappings: placement.translatorMappings
    });
    const parameterizedTranslator = new SqlTranslator({
      fieldMappings: placement.translatorMappings
    });

    it.each(filters)(
      '%s resolves to status on every engine',
      async (query, expected) => {
        const expression = parser.parse(query);
        const inline = inlineTranslator.translate(expression) as string;
        expect(inline).not.toContain('"a"');
        expect(idsOfSql(`${inline} ORDER BY id`)).toEqual(expected);
        const parameterized = parameterizedTranslator.translate(
          expression
        ) as IParameterizedSql;
        expect(
          idsOfSql(`${parameterized.sql} ORDER BY id`, parameterized.params)
        ).toEqual(expected);
        for (const kit of placement.kits) {
          const viaKit = await kit
            .query('items')
            .where(query)
            .orderBy('id')
            .execute();
          expect(idsOf(viaKit)).toEqual(expected);
        }
      }
    );

    it.each(sorts)(
      'orderBy %s %s orders by status on every engine',
      async (field, direction, expected) => {
        const expression = parser.parse('id:>0');
        const inline = inlineTranslator.translate(expression) as string;
        expect(
          idsOfSql(`${inline} ORDER BY "status" ${direction.toUpperCase()}`)
        ).toEqual(expected);
        const parameterized = parameterizedTranslator.translate(
          expression
        ) as IParameterizedSql;
        expect(
          idsOfSql(
            `${parameterized.sql} ORDER BY "status" ${direction.toUpperCase()}`,
            parameterized.params
          )
        ).toEqual(expected);
        for (const kit of placement.kits) {
          const viaKit = await kit
            .query('items')
            .where('id:>0')
            .orderBy(field, direction)
            .execute();
          expect(idsOf(viaKit)).toEqual(expected);
        }
      }
    );
  });
});
