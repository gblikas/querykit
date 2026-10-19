/**
 * Ordered comparison at the signed 64-bit minimum.
 *
 * `count:>-9223372036854775808` keeps only the neighbour and `>=` keeps the
 * minimum too, as exact bigints on every engine. One past the minimum,
 * `-9223372036854775809`, would round onto the stored minimum, so the parser
 * rejects it, the search box marks it incomplete and no engine compares the
 * rounded number. A quoted spelling stays a complete string.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../../parser';
import { isInputComplete } from '../../parser/input-parser';
import { QueryParseError } from '../../parser/parser';
import { filterInMemory } from './filter-in-memory';
import { openSqliteHarness } from '../../test-support';

const MINIMUM = -9223372036854775808n;

const rows: Array<{ id: number; count: bigint }> = [
  { id: 1, count: MINIMUM },
  { id: 2, count: -9223372036854775807n }
];

const items = sqliteTable('items', {
  id: integer('id'),
  count: integer('count')
});

describe('ordered comparison at the signed 64-bit minimum', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { count: 'INTEGER' },
    rows
  });

  it.each([
    ['count:>-9223372036854775808', '>', [2]],
    ['count:>=-9223372036854775808', '>=', [1, 2]],
    ['count:-9223372036854775808', '==', [1]]
  ])('%s keeps the exact minimum on every engine', (query, operator, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field: 'count',
      operator,
      value: MINIMUM
    });
    const run = harness.expectSameIds(query, ids);
    expect(run.inlineSql).toContain('-9223372036854775808');
    expect(run.parameterized.params).toEqual([MINIMUM]);
  });

  it('rejects one past the minimum instead of matching the minimum', () => {
    const query = 'count:-9223372036854775809';
    const message =
      'Integer is outside the signed 64-bit range: -9223372036854775809';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
  });

  it('keeps a quoted spelling a complete string', () => {
    const query = 'count:"-9223372036854775809"';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'count',
      operator: '==',
      value: '-9223372036854775809'
    });
  });
});
