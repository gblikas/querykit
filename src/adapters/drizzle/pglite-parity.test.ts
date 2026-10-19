/**
 * The Drizzle adapter on PostgreSQL (PGlite) beside the in-memory adapter.
 *
 * Every other parity test in the suite runs SQLite. This one runs the same
 * rows through PGlite and states, cell by cell, what PostgreSQL returns and
 * what the in-memory adapter returns, so the two are never assumed to
 * agree where they do not:
 *
 * - A boolean literal is bound through the schema column's own mapping,
 *   as `eq(column, true)` binds it: `flag:true` reaches a `boolean()`
 *   column as a boolean parameter, and against a `text()` or `integer()`
 *   column PostgreSQL (or PGlite's parameter serializer) rejects it with
 *   its own message rather than a hard-coded `TRUE` the engine cannot
 *   compare. The in-memory adapter follows SQLite, where a boolean is its
 *   integer, so `flag:1` and `count:true` match rows there.
 * - `status:op*` is case-sensitive on PostgreSQL and folds ASCII case in
 *   memory, as SQLite's LIKE does, so the `Open` row differs.
 * - PostgreSQL orders NULL last under ASC and first under DESC; the
 *   in-memory adapter orders NULL first under ASC, as SQLite does.
 */

// The `WebAssembly` namespace PGlite's options name lives in the DOM lib.
/// <reference lib="dom" />

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, PgliteDatabase } from 'drizzle-orm/pglite';
import {
  boolean,
  integer,
  PgDialect,
  pgTable,
  text
} from 'drizzle-orm/pg-core';
import { InMemoryAdapter } from '../memory';
import { QueryParser } from '../../parser';
import { DrizzleTranslator } from '../../translators/drizzle';
import { DrizzleAdapter, DrizzleAdapterError } from './index';

interface IItemRow {
  id: number;
  flag: boolean | null;
  label: string | null;
  count: number | null;
  status: string | null;
}

/**
 * One query with the ids PostgreSQL returns, or the message it rejects the
 * query with, and the ids the in-memory adapter returns for the same rows.
 */
interface IParityCase {
  query: string;
  orderBy: Record<string, 'asc' | 'desc'>;
  pglite: number[] | RegExp;
  memory: number[];
}

const items = pgTable('items', {
  id: integer('id').primaryKey(),
  flag: boolean('flag'),
  label: text('label'),
  count: integer('count'),
  status: text('status')
});

const rows: IItemRow[] = [
  { id: 1, flag: true, label: 'true', count: 1, status: 'open' },
  { id: 2, flag: false, label: 'false', count: 2, status: 'closed' },
  { id: 3, flag: null, label: null, count: null, status: null },
  { id: 4, flag: true, label: 'Open', count: 3, status: 'Open' },
  { id: 5, flag: false, label: 'open', count: 0, status: 'opened' }
];

const byId: Record<string, 'asc' | 'desc'> = { id: 'asc' };

const filterCases: IParityCase[] = [
  { query: 'flag:true', orderBy: byId, pglite: [1, 4], memory: [1, 4] },
  { query: 'flag:false', orderBy: byId, pglite: [2, 5], memory: [2, 5] },
  {
    query: 'flag:1',
    orderBy: byId,
    pglite: /Invalid input for boolean type/,
    memory: [1, 4]
  },
  {
    query: 'label:true',
    orderBy: byId,
    pglite: /Invalid input for string type/,
    memory: []
  },
  {
    query: 'count:true',
    orderBy: byId,
    pglite: /invalid input syntax for type integer: "true"/,
    memory: [1]
  },
  { query: 'status:open', orderBy: byId, pglite: [1], memory: [1] },
  { query: 'status:op*', orderBy: byId, pglite: [1, 5], memory: [1, 4, 5] },
  { query: 'status:null', orderBy: byId, pglite: [3], memory: [3] },
  { query: 'count:>1', orderBy: byId, pglite: [2, 4], memory: [2, 4] },
  {
    query: 'status:in [open, closed]',
    orderBy: byId,
    pglite: [1, 2],
    memory: [1, 2]
  }
];

// `id:>0` keeps every row; the second key makes ties deterministic.
const orderCases: IParityCase[] = [
  {
    query: 'id:>0',
    orderBy: { flag: 'asc', id: 'asc' },
    pglite: [2, 5, 1, 4, 3],
    memory: [3, 2, 5, 1, 4]
  },
  {
    query: 'id:>0',
    orderBy: { flag: 'desc', id: 'asc' },
    pglite: [3, 1, 4, 2, 5],
    memory: [1, 4, 2, 5, 3]
  },
  {
    query: 'id:>0',
    orderBy: { label: 'asc', id: 'asc' },
    pglite: [4, 2, 5, 1, 3],
    memory: [3, 4, 2, 5, 1]
  },
  {
    query: 'id:>0',
    orderBy: { label: 'desc', id: 'asc' },
    pglite: [3, 1, 5, 2, 4],
    memory: [1, 5, 2, 4, 3]
  },
  {
    query: 'id:>0',
    orderBy: { count: 'asc', id: 'asc' },
    pglite: [5, 1, 2, 4, 3],
    memory: [3, 5, 1, 2, 4]
  },
  {
    query: 'id:>0',
    orderBy: { count: 'desc', id: 'asc' },
    pglite: [3, 4, 2, 1, 5],
    memory: [4, 2, 1, 5, 3]
  },
  {
    query: 'id:>0',
    orderBy: { status: 'asc', id: 'asc' },
    pglite: [4, 2, 1, 5, 3],
    memory: [3, 4, 2, 1, 5]
  },
  {
    query: 'id:>0',
    orderBy: { status: 'desc', id: 'asc' },
    pglite: [3, 5, 1, 2, 4],
    memory: [5, 1, 2, 4, 3]
  }
];

/**
 * PGlite loads its WebAssembly and data files through a dynamic `import()`
 * that Jest's module sandbox cannot run, so both are read here and handed
 * to the constructor, which then imports nothing.
 */
async function preloadedPgliteBundle(): Promise<{
  wasmModule: WebAssembly.Module;
  fsBundle: Blob;
}> {
  const distDirectory = dirname(require.resolve('@electric-sql/pglite'));
  const readBytes = (fileName: string): Uint8Array<ArrayBuffer> => {
    const fileBytes = readFileSync(join(distDirectory, fileName));
    const bytes = new Uint8Array(fileBytes.byteLength);
    bytes.set(fileBytes);
    return bytes;
  };
  const wasmModule = await WebAssembly.compile(readBytes('pglite.wasm'));
  const fsBundle = new Blob([readBytes('pglite.data')]);
  return { wasmModule, fsBundle };
}

/**
 * Start PGlite inside Jest. Its Emscripten module also awaits
 * `import("module")` when it finds itself in Node, so for the start-up
 * alone the sandbox's `process` is marked as an Electron renderer, the one
 * Node-like host Emscripten does not treat as Node; nothing is read from
 * disk in that branch once the bundle is preloaded.
 */
async function startPglite(): Promise<PGlite> {
  const bundle = await preloadedPgliteBundle();
  const sandboxProcess = process as { type?: string };
  const previousType = sandboxProcess.type;
  sandboxProcess.type = 'renderer';
  try {
    const client = new PGlite(bundle);
    await client.waitReady;
    return client;
  } finally {
    sandboxProcess.type = previousType;
  }
}

/** The parameterized SQL the translator compiles for PostgreSQL. */
const compiledCases: Array<[string, string, unknown[]]> = [
  ['flag:true', '"items"."flag" = $1', [true]],
  ['flag:false', '"items"."flag" = $1', [false]],
  ['label:true', '"items"."label" = $1', [true]],
  ['count:true', '"items"."count" = $1', [true]],
  ['flag:in [true, false]', '"items"."flag" in ($1, $2)', [true, false]],
  ['flag:1', '"items"."flag" = $1', [1]]
];

describe('the Drizzle adapter on PGlite beside the in-memory adapter', () => {
  const parser = new QueryParser();
  const memoryAdapter = new InMemoryAdapter({ records: { items: rows } });
  let client: PGlite;
  let db: PgliteDatabase;
  let pgliteAdapter: DrizzleAdapter;

  beforeAll(async (): Promise<void> => {
    client = await startPglite();
    await client.exec(
      'CREATE TABLE items (id integer PRIMARY KEY, flag boolean, label text, count integer, status text)'
    );
    db = drizzle(client);
    await db.insert(items).values(rows);
    pgliteAdapter = new DrizzleAdapter({ db, schema: { items } });
  });

  afterAll(async (): Promise<void> => {
    await client.close();
  });

  async function idsOf(
    adapter: DrizzleAdapter | InMemoryAdapter,
    parityCase: IParityCase
  ): Promise<number[]> {
    const expression = parser.parse(parityCase.query);
    const result = await adapter.execute<IItemRow>('items', expression, {
      orderBy: parityCase.orderBy
    });
    return result.map(row => row.id);
  }

  function titleOf(parityCase: IParityCase): string {
    const keys = Object.entries(parityCase.orderBy)
      .map(([field, direction]) => `${field} ${direction}`)
      .join(', ');
    return `${parityCase.query} ordered by ${keys}`;
  }

  describe.each([
    ['filters', filterCases],
    ['ordering', orderCases]
  ])('%s', (_group, cases) => {
    const titledCases: Array<[string, IParityCase]> = cases.map(parityCase => [
      titleOf(parityCase),
      parityCase
    ]);

    it.each(titledCases)('%s on PostgreSQL', async (_title, parityCase) => {
      if (parityCase.pglite instanceof RegExp) {
        const rejected = idsOf(pgliteAdapter, parityCase);
        await expect(rejected).rejects.toThrow(DrizzleAdapterError);
        await expect(rejected).rejects.toThrow(parityCase.pglite);
        return;
      }
      const actualIds = await idsOf(pgliteAdapter, parityCase);
      expect(actualIds).toEqual(parityCase.pglite);
    });

    it.each(titledCases)('%s in memory', async (_title, parityCase) => {
      const actualIds = await idsOf(memoryAdapter, parityCase);
      expect(actualIds).toEqual(parityCase.memory);
    });
  });

  it('keeps the database error as the cause of the adapter error', async () => {
    const expression = parser.parse('count:true');
    const rejected = pgliteAdapter.execute('items', expression);
    await expect(rejected).rejects.toMatchObject({
      cause: expect.objectContaining({ cause: expect.any(Error) })
    });
  });

  describe('the compiled PostgreSQL condition', () => {
    const dialect = new PgDialect();
    const translator = new DrizzleTranslator({ schema: { items } });

    it.each(compiledCases)(
      '%s binds the literal through the column instead of inlining it',
      (query, expectedSql, expectedParams) => {
        const compiled = dialect.sqlToQuery(
          translator.translate(parser.parse(query), { tableName: 'items' })
        );
        expect({ sql: compiled.sql, params: compiled.params }).toEqual({
          sql: expectedSql,
          params: expectedParams
        });
      }
    );
  });
});
