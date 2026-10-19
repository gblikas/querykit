/**
 * A dotted field `owner.city`.
 *
 * The SQL names two identifiers, `"owner"."city"`: column `city` of table
 * `owner`. The in-memory reader reads an own key `owner.city` when the row
 * has one and otherwise the own key `city`, the column SQL addresses. A
 * nested `{ owner: { city } }` is not walked.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryParser } from '../parser';
import { openSqliteHarness } from '../test-support';

const rows = [
  { id: 1, city: 'Austin' },
  { id: 2, city: 'Boston' },
  { id: 3, city: null }
];

const owner = sqliteTable('owner', {
  id: integer('id'),
  city: text('city')
});

describe('a dotted field', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: owner,
    columns: { city: 'TEXT' },
    rows
  });
  const query = 'owner.city:Austin';

  it('names column city of table owner on every SQL engine', () => {
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field: 'owner.city',
      operator: '==',
      value: 'Austin'
    });
    const run = harness.expectSameSqlIds(query, [1]);
    expect(run.inlineSql).toBe(`"owner"."city" = 'Austin'`);
    expect(run.parameterized).toEqual({
      sql: '"owner"."city" = ?',
      params: ['Austin']
    });
    expect(run.drizzle).toEqual({
      sql: '"owner"."city" = ?',
      params: ['Austin']
    });
    expect(run.schemaDrizzle).toEqual({
      sql: '"owner"."city" = ?',
      params: ['Austin']
    });
  });

  it('reads the column in memory when the row has no key of the whole name', () => {
    const columnRows = [
      { id: 1, city: 'Austin' },
      { id: 2, city: 'Boston' },
      { id: 3, city: null }
    ];
    expect(filterInMemory(query, columnRows).map(row => row.id)).toEqual([1]);
    expect(
      filterInMemory('owner.city:null', columnRows).map(r => r.id)
    ).toEqual([3]);
  });

  it('reads an own key of the whole name first', () => {
    const literalRows = [
      { id: 1, 'owner.city': 'Austin', city: 'Boston' },
      { id: 2, 'owner.city': 'Boston', city: 'Austin' }
    ];
    expect(filterInMemory(query, literalRows).map(row => row.id)).toEqual([1]);
  });

  it('does not walk a nested object', () => {
    const nestedRows = [
      { id: 1, owner: { city: 'Austin' } },
      { id: 2, owner: { city: 'Boston' } }
    ];
    expect(filterInMemory(query, nestedRows)).toEqual([]);
  });
});
