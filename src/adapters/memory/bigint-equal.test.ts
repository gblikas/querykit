/**
 * Equality with an integer past the safe range.
 *
 * `count:9007199254740993` (2^53 + 1) is read from the source digits as a
 * bigint, so no engine compares the rounded neighbour 2^53. Inline SQL
 * writes the digits, parameterized SQL and Drizzle bind the bigint, and the
 * row holding the exact value is the only match. `count:1` is unchanged.
 *
 * In memory a bigint field equals a finite number of the same value.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { isInputComplete } from '../../parser/input-parser';
import { QueryExpression } from '../../parser/types';
import { SqlTranslator } from '../../translators/sql';
import { filterInMemory } from './filter-in-memory';
import { openSqliteHarness } from '../../test-support';

const rows: Array<{ id: number; count: bigint | number }> = [
  { id: 1, count: 9007199254740993n },
  { id: 2, count: 9007199254740992n },
  { id: 3, count: 1n },
  { id: 4, count: 1 }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: integer('count')
});

const cases: Array<[string, bigint | number, string, number[]]> = [
  ['count:9007199254740993', 9007199254740993n, '9007199254740993', [1]],
  ['count:1', 1, '1', [3, 4]]
];

describe('equality with an integer past the safe range', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { count: 'INTEGER' },
    rows
  });

  it.each(cases)(
    '%s keeps the exact integer on every SQL engine',
    (query, value, digits, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field: 'count',
        operator: '==',
        value
      });
      const run = harness.expectSameSqlIds(query, expectedIds);
      const inlineSql =
        typeof value === 'bigint'
          ? `"count" = ${digits}`
          : `("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = ${digits})`;
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({
        sql: '"count" = ?',
        params: [value]
      });
      expect(run.drizzle).toEqual({ sql: '"count" = ?', params: [value] });
      expect(run.schemaDrizzle).toEqual({
        sql: '"items"."count" = ?',
        params: [value]
      });
    }
  );

  it('still rejects a hand-built safe bigint inline and binds it as a parameter', () => {
    const expression: QueryExpression = {
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: 10n
    };
    expect(() =>
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toThrow('Unsupported value type: bigint');
    expect(new SqlTranslator().translate(expression)).toEqual({
      sql: '"count" = ?',
      params: [10n]
    });
  });

  // A bigint field equals a finite number of the same value, so `count:1`
  // keeps the `1n` row as well.
  describe('in memory', () => {
    it.each(cases)('%s matches the SQL engines', (query, _value, _d, ids) => {
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
    });
  });
});
