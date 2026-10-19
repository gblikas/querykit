/**
 * A quoted numeral compared with a numeric field.
 *
 * `count:"2"` binds the text `2`. A PostgreSQL `integer` column reads that
 * text as the number 2, and a SQLite column declared `INTEGER` or `REAL`
 * converts it by affinity, so both match the row holding 2 and compare
 * `count:>"1"` numerically; a column with no declared type and, before
 * this rule, the in-memory adapter kept the text and matched nothing. The
 * adapter now reads a quoted decimal against a number, a bigint or a
 * boolean (stored as 0 or 1) as the number it spells, exactly past 2^53,
 * with the leading plus and the surrounding whitespace both databases skip.
 * A quoted word, an exponent (which PostgreSQL rejects for an integer where
 * SQLite reads 10) and a bare number against a text field keep their own
 * class, as the PGlite parity survey records.
 *
 * The rows and the expected ids are the survey's dataset (groups 4a, 3d and
 * 4b of `docs/pglite-parity-survey.md`), measured on PGlite 17.5 and on a
 * typed better-sqlite3 table; the typed table is measured again here.
 */

import { createRequire } from 'module';
import {
  integer,
  real,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { QueryExpression } from '../../parser/types';
import { DrizzleTranslator } from '../../translators/drizzle';
import { InMemoryAdapter } from './in-memory-adapter';

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

interface IItemRow {
  id: number;
  status: string | null;
  count: number | null;
  flag: boolean | null;
  big: bigint | null;
  label: string | null;
  price: number | null;
  created: Date | null;
}

/** One query, the survey cell it reproduces, and the ids both engines return. */
type ParityCell = [string, number, number[]];

const rows: IItemRow[] = [
  {
    id: 1,
    status: 'open',
    count: 1,
    flag: true,
    big: 9007199254740993n,
    label: '10',
    price: 1.5,
    created: new Date('2024-01-01T00:00:00.000Z')
  },
  {
    id: 2,
    status: 'Open',
    count: 2,
    flag: false,
    big: 9007199254740992n,
    label: '9',
    price: 2.5,
    created: new Date('2024-06-15T12:00:00.000Z')
  },
  {
    id: 3,
    status: 'OPEN',
    count: 3,
    flag: true,
    big: -1n,
    label: '2',
    price: 10,
    created: new Date('2023-12-31T23:59:59.000Z')
  },
  {
    id: 4,
    status: 'öpen',
    count: 0,
    flag: false,
    big: 0n,
    label: '',
    price: 0,
    created: new Date('2024-01-01T00:00:00.000Z')
  },
  {
    id: 5,
    status: 'Öpen',
    count: -1,
    flag: null,
    big: null,
    label: 'a',
    price: null,
    created: null
  },
  {
    id: 6,
    status: 'closed',
    count: 10,
    flag: true,
    big: 10n,
    label: '10',
    price: 1.5,
    created: new Date('2025-01-01T00:00:00.000Z')
  },
  {
    id: 7,
    status: '',
    count: null,
    flag: false,
    big: 1n,
    label: null,
    price: 2.5,
    created: new Date('2024-12-31T00:00:00.000Z')
  },
  {
    id: 8,
    status: null,
    count: 2,
    flag: true,
    big: 9007199254740993n,
    label: '2',
    price: 10,
    created: null
  },
  {
    id: 9,
    status: 'é',
    count: 1,
    flag: null,
    big: 2n,
    label: '1.5',
    price: 0.5,
    created: new Date('2024-01-01T00:00:00.500Z')
  },
  {
    id: 10,
    status: 'e\u0301',
    count: 1,
    flag: false,
    big: 3n,
    label: '-1',
    price: -1.5,
    created: new Date('2024-03-01T00:00:00.000Z')
  },
  {
    id: 11,
    status: '100%',
    count: 100,
    flag: true,
    big: 100n,
    label: '100',
    price: 100,
    created: new Date('2024-04-01T00:00:00.000Z')
  },
  {
    id: 12,
    status: '100x',
    count: 100,
    flag: false,
    big: 100n,
    label: '100',
    price: 100,
    created: new Date('2024-05-01T00:00:00.000Z')
  },
  {
    id: 13,
    status: 'a_b',
    count: 5,
    flag: true,
    big: 5n,
    label: '5',
    price: 5,
    created: new Date('2024-07-01T00:00:00.000Z')
  },
  {
    id: 14,
    status: 'axb',
    count: 5,
    flag: false,
    big: 6n,
    label: '05',
    price: 5.5,
    created: new Date('2024-08-01T00:00:00.000Z')
  },
  {
    id: 15,
    status: 'a!b',
    count: 0,
    flag: null,
    big: null,
    label: 'A',
    price: null,
    created: new Date('2024-09-01T00:00:00.000Z')
  },
  {
    id: 16,
    status: 'ship release',
    count: 7,
    flag: true,
    big: 7n,
    label: '7',
    price: 7,
    created: new Date('2024-10-01T00:00:00.000Z')
  }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  count: integer('count'),
  flag: integer('flag', { mode: 'boolean' }),
  big: integer('big'),
  label: text('label'),
  price: real('price'),
  created: text('created')
});

// Survey cells 96, 109, 110, 111, 113, 114, 115, 159, 160, 212, 213 and
// 224: PGlite and the typed SQLite table agree on every one. `!=` is the
// negation of cell 96.
const affinityCells: ParityCell[] = [
  ['count:"2"', 96, [2, 8]],
  ['count:!="2"', 96, [1, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 15, 16]],
  ['count:in ["2", 3]', 109, [2, 3, 8]],
  ['count:>"1"', 110, [2, 3, 6, 8, 11, 12, 13, 14, 16]],
  ['count:[1 TO "3"]', 111, [1, 2, 3, 8, 9, 10]],
  ['count:" 2"', 113, [2, 8]],
  ['count:"2 "', 114, [2, 8]],
  ['count:"+2"', 115, [2, 8]],
  ['big:"10"', 159, [6]],
  ['big:"9007199254740993"', 160, [1, 8]],
  ['price:"1.5"', 212, [1, 6]],
  ['price:"10"', 213, [3, 8]],
  ['price:in ["1.5"]', 224, [1, 6]]
];

// Cells the rule leaves where the survey found them in memory: a quoted
// word and an exponent (group 3d, where PostgreSQL rejects the text), a
// bare number against a text field (group 4b, where the two databases
// disagree with each other) and a word against a boolean (group 3b).
const unchangedCells: ParityCell[] = [
  ['count:"two"', 97, []],
  ['count:"1e1"', 108, []],
  ['label:10', 172, []],
  ['label:>5', 178, [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16]],
  ['label:"10"', 173, [1, 6]],
  ['flag:"true"', 123, []]
];

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT, count INTEGER, flag INTEGER, big INTEGER, label TEXT, price REAL, created TEXT)'
  );
  const insert = database.prepare(
    'INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.status,
      row.count,
      row.flag === null ? null : row.flag ? 1 : 0,
      row.big,
      row.label,
      row.price,
      row.created === null ? null : row.created.toISOString()
    );
  }
  return database;
}

describe('a quoted numeral compared with a numeric field', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const translator = new DrizzleTranslator({ schema: { items } });
  const database = openDatabase();
  const adapter = new InMemoryAdapter({ records: { items: rows } });

  afterAll((): void => {
    database.close();
  });

  function idsOnTypedSqlite(expression: QueryExpression): number[] {
    const compiled = dialect.sqlToQuery(
      translator.translate(expression, { tableName: 'items' })
    );
    return database
      .prepare(`SELECT id FROM items WHERE ${compiled.sql} ORDER BY id`)
      .all(...compiled.params)
      .map(row => row.id);
  }

  async function idsInMemory(expression: QueryExpression): Promise<number[]> {
    const result = await adapter.execute<IItemRow>('items', expression, {
      orderBy: { id: 'asc' }
    });
    return result.map(row => row.id);
  }

  describe('takes the affinity of the field, as a typed SQLite column does', () => {
    it.each(affinityCells)(
      '%s (survey cell %i)',
      async (query, _cell, expectedIds) => {
        const expression = parser.parse(query);
        expect(idsOnTypedSqlite(expression)).toEqual(expectedIds);
        expect(await idsInMemory(expression)).toEqual(expectedIds);
      }
    );
  });

  describe('leaves every other pairing as the survey found it', () => {
    it.each(unchangedCells)(
      '%s (survey cell %i)',
      async (query, _cell, expectedIds) => {
        expect(await idsInMemory(parser.parse(query))).toEqual(expectedIds);
      }
    );
  });
});
