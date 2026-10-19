/**
 * A stored NaN.
 *
 * A bound NaN is NULL in SQLite. Memory treats a numeric NaN the same way:
 * `amount:null` matches it, every other comparison is unknown, and it sorts
 * with the nulls. No statement can carry a NaN literal: SQLite reads `NaN`
 * as a column name and the translators reject a non-finite number.
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, real, sqliteTable } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../drizzle';
import { QueryParser } from '../../parser';
import { QueryExpression } from '../../parser/types';
import { DrizzleTranslator } from '../../translators/drizzle';
import { SqlTranslator } from '../../translators/sql';
import { inMemoryAdapter } from './in-memory-adapter';
import { IParameterizedSql, openSqliteHarness } from '../../test-support';

type Direction = 'asc' | 'desc';

const rows: Array<{ id: number; amount: number | null }> = [
  { id: 1, amount: NaN },
  { id: 2, amount: null },
  { id: 3, amount: 0 },
  { id: 4, amount: 1 }
];

const amounts = sqliteTable('amounts', {
  id: integer('id'),
  amount: real('amount')
});

describe('a stored NaN', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: amounts,
    columns: { amount: 'REAL' },
    rows
  });
  const adapter = new DrizzleAdapter({
    db: drizzle(harness.database as never),
    schema: { amounts }
  });
  const memory = inMemoryAdapter({ records: { amounts: rows } });

  it('is stored as NULL', () => {
    expect(
      harness.database
        .prepare('SELECT id FROM amounts WHERE amount IS NULL ORDER BY id')
        .all()
        .map(row => row.id)
    ).toEqual([1, 2]);
  });

  it('cannot be written into a statement', () => {
    expect(() =>
      harness.database
        .prepare('SELECT id FROM amounts WHERE "amount" = NaN')
        .all()
    ).toThrow('no such column: NaN');
    const expression: QueryExpression = {
      type: 'comparison',
      field: 'amount',
      operator: '==',
      value: NaN
    };
    expect(() => new SqlTranslator().translate(expression)).toThrow(
      'Non-finite numbers are not supported'
    );
    expect(() => new DrizzleTranslator().translate(expression)).toThrow(
      'Non-finite numbers are not supported'
    );
  });

  it.each([
    ['amount:null', [1, 2]],
    ['amount:0', [3]],
    ['amount:>0', [4]],
    ['amount:>=0', [3, 4]],
    ['amount:<0', []],
    ['amount:<=0', [3]],
    ['amount:>1', []],
    ['amount:>=1', [4]],
    ['amount:<1', [3]],
    ['amount:<=1', [3, 4]]
  ])('%s matches the same rows on every engine', async (query, expectedIds) => {
    const expression = parser.parse(query);
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(harness.idsOfSql({ sql: inline, params: [] })).toEqual(expectedIds);
    expect(harness.idsOfSql(parameterized)).toEqual(expectedIds);
    expect(harness.idsOfSql(harness.compileDrizzle(expression))).toEqual(
      expectedIds
    );
    const viaDrizzle = await adapter.execute<{ id: number }>(
      'amounts',
      expression,
      { orderBy: { id: 'asc' } }
    );
    expect(viaDrizzle.map(row => row.id)).toEqual(expectedIds);
    const viaMemory = await memory.execute<{ id: number }>(
      'amounts',
      expression,
      { orderBy: { id: 'asc' } }
    );
    expect(viaMemory.map(row => row.id)).toEqual(expectedIds);
  });

  it.each([
    ['asc', [1, 2, 3, 4]],
    ['desc', [4, 3, 1, 2]]
  ] as Array<[Direction, number[]]>)(
    'sorts with the nulls %s on every engine',
    async (direction, expectedIds) => {
      const expression = parser.parse('id:>=0');
      const inline = new SqlTranslator({ useParameters: false }).translate(
        expression
      ) as string;
      const parameterized = new SqlTranslator().translate(
        expression
      ) as IParameterizedSql;
      const orderBy = `"amount" ${direction.toUpperCase()}, id ASC`;
      expect(harness.idsOfSql({ sql: inline, params: [] }, orderBy)).toEqual(
        expectedIds
      );
      expect(harness.idsOfSql(parameterized, orderBy)).toEqual(expectedIds);
      const options = { orderBy: { amount: direction, id: 'asc' as const } };
      const viaDrizzle = await adapter.execute<{ id: number }>(
        'amounts',
        expression,
        options
      );
      expect(viaDrizzle.map(row => row.id)).toEqual(expectedIds);
      const viaMemory = await memory.execute<{ id: number }>(
        'amounts',
        expression,
        options
      );
      expect(viaMemory.map(row => row.id)).toEqual(expectedIds);
    }
  );
});
