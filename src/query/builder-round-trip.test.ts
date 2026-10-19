/**
 * QueryBuilder values round-tripped through the parser and every engine.
 *
 * For each operator the builder's text is parsed by a fresh `QueryParser`
 * and run on inline SQL, parameterized SQL, the Drizzle adapter and the
 * in-memory adapter, which return the same ids: a boolean, `null`, the
 * empty string, a string that needs quotes, a dotted field and finite
 * numbers all come back as the value the builder was given. A non-finite
 * number has no Liqe spelling (`NaN` and `Infinity` are bare words and
 * `-Infinity` is a syntax error), so the builder rejects it with
 * `QueryBuilderError` instead of emitting a different value, alone and as
 * a membership member.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../adapters/drizzle';
import { inMemoryAdapter } from '../adapters/memory';
import { QueryParser } from '../parser';
import { SqlTranslator } from '../translators/sql';
import { QueryBuilder } from './builder';
import { QueryBuilderError } from './query-builder-error';
import { ComparisonOperator, QueryValue } from './types';

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
  score: number;
  flag: boolean | null;
  note: string | null;
  label: string | null;
}

interface IOwnerRow {
  id: number;
  'owner.city': string | null;
}

type Row = Record<string, unknown>;

const OPERATORS: ComparisonOperator[] = [
  '==',
  '>',
  '>=',
  '<',
  '<=',
  'IN',
  'NOT IN'
];

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  score: real('score'),
  flag: integer('flag', { mode: 'boolean' }),
  note: text('note'),
  label: text('label')
});

const owner = sqliteTable('owner', {
  id: integer('id').primaryKey(),
  city: text('city')
});

const itemRows: IItem[] = [
  { id: 1, score: -3, flag: true, note: 'say "hi"', label: '' },
  { id: 2, score: 1.5, flag: false, note: null, label: 'x' },
  { id: 3, score: 0, flag: true, note: 'plain', label: null },
  { id: 4, score: 7, flag: null, note: '', label: 'say "hi"' }
];

const ownerRows: IOwnerRow[] = [
  { id: 1, 'owner.city': 'Paris' },
  { id: 2, 'owner.city': '' },
  { id: 3, 'owner.city': null },
  { id: 4, 'owner.city': 'Berlin' }
];

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, score REAL, flag INTEGER, note TEXT, label TEXT);
    INSERT INTO items VALUES
      (1, -3, 1, 'say "hi"', ''), (2, 1.5, 0, NULL, 'x'),
      (3, 0, 1, 'plain', NULL), (4, 7, NULL, '', 'say "hi"');
    CREATE TABLE owner (id INTEGER PRIMARY KEY, city TEXT);
    INSERT INTO owner VALUES (1, 'Paris'), (2, ''), (3, NULL), (4, 'Berlin');
  `);
  return database;
}

function builder(): QueryBuilder<Row> {
  return new QueryBuilder<Row>();
}

/** The value as the builder takes it for an operator: a list for IN and NOT IN. */
function valueFor(operator: ComparisonOperator, value: QueryValue): QueryValue {
  return operator === 'IN' || operator === 'NOT IN'
    ? [value as string | number | boolean | null]
    : value;
}

describe('builder values on every engine', () => {
  const database = openDatabase();
  const db = drizzle(database as never);
  const drizzleAdapter = new DrizzleAdapter({ db, schema: { items, owner } });
  const memoryAdapter = inMemoryAdapter({
    records: { items: itemRows, owner: ownerRows }
  });

  afterAll((): void => {
    database.close();
  });

  /** Run the builder's text on every engine and return the ids each gave. */
  async function idsOnEveryEngine(
    table: 'items' | 'owner',
    field: string,
    operator: ComparisonOperator,
    value: QueryValue
  ): Promise<{ text: string; ids: number[][] }> {
    const text = builder().where(field, operator, value).toString();
    const expression = new QueryParser().parse(text);
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    const fromInline = database
      .prepare(`SELECT id FROM ${table} WHERE ${inline} ORDER BY id`)
      .all()
      .map(row => row.id);
    const fromParameterized = database
      .prepare(`SELECT id FROM ${table} WHERE ${parameterized.sql} ORDER BY id`)
      .all(...parameterized.params)
      .map(row => row.id);
    const fromDrizzle = (
      await drizzleAdapter.execute<{ id: number }>(table, expression, {
        orderBy: { id: 'asc' }
      })
    ).map(row => row.id);
    const inMemory = (
      await memoryAdapter.execute<{ id: number }>(table, expression, {
        orderBy: { id: 'asc' }
      })
    ).map(row => row.id);
    return {
      text,
      ids: [fromInline, fromParameterized, fromDrizzle, inMemory]
    };
  }

  it.each<[string, 'items' | 'owner', string, QueryValue, number[]]>([
    ['boolean true', 'items', 'flag', true, [1, 3]],
    ['boolean false', 'items', 'flag', false, [2]],
    ['null', 'items', 'note', null, [2]],
    ['the empty string', 'items', 'label', '', [1]],
    ['a string that needs quotes', 'items', 'note', 'say "hi"', [1]],
    ['a dotted field', 'owner', 'owner.city', 'Paris', [1]],
    ['a dotted field and the empty string', 'owner', 'owner.city', '', [2]],
    ['a negative number', 'items', 'score', -3, [1]],
    ['a fraction', 'items', 'score', 1.5, [2]]
  ])(
    'round-trips %s through every operator',
    async (_name, table, field, value, equalIds) => {
      for (const operator of OPERATORS) {
        const { text, ids } = await idsOnEveryEngine(
          table,
          field,
          operator,
          valueFor(operator, value)
        );
        const [fromInline, ...others] = ids;
        for (const other of others) {
          expect({ operator, text, ids: other }).toEqual({
            operator,
            text,
            ids: fromInline
          });
        }
        if (operator === '==' || operator === 'IN') {
          expect({ operator, text, ids: fromInline }).toEqual({
            operator,
            text,
            ids: equalIds
          });
        }
      }
    }
  );

  it('rejects a non-finite number instead of emitting a different value', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      for (const operator of OPERATORS) {
        expect(() =>
          builder().where('score', operator, valueFor(operator, value))
        ).toThrow(QueryBuilderError);
        expect(() =>
          builder().where('score', operator, valueFor(operator, value))
        ).toThrow(
          `Non-finite numbers are not supported. Got: ${String(value)}`
        );
      }
      expect(() => builder().where('score', 'IN', [1, value])).toThrow(
        QueryBuilderError
      );
      expect(() => builder().andWhere('score', '>', value)).toThrow(
        QueryBuilderError
      );
    }
    expect(builder().where('score', '==', -3).toString()).toBe('score:-3');
    expect(builder().where('score', 'IN', [1.5, 7]).toString()).toBe(
      'score:in[1.5,7]'
    );
  });
});
