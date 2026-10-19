/**
 * The empty string against null.
 *
 * `name:""` matches only the empty string and `name:null` only null, on
 * inline SQL, parameterized SQL, Drizzle and in memory. Inequality with `""`
 * leaves the null row out (unknown stays unknown under NOT), inequality
 * with null keeps every non-null value including `""`, and `LIKE '%'`
 * matches every non-null string including the empty one.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterByExpression } from '../adapters/memory/match-expression';
import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { openSqliteHarness } from '../test-support';

const rows: Array<{ id: number; name: string | null }> = [
  { id: 1, name: '' },
  { id: 2, name: null },
  { id: 3, name: 'a' },
  { id: 4, name: ' ' },
  { id: 5, name: 'ab' },
  { id: 6, name: '%' },
  { id: 7, name: '_' },
  { id: 8, name: '!' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  name: text('name')
});

describe('the empty string against null', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { name: 'TEXT' },
    rows
  });

  function expectIds(expression: QueryExpression, expectedIds: number[]): void {
    harness.expectSameSqlIds(expression, expectedIds);
    expect(filterByExpression(expression, rows).map(row => row.id)).toEqual(
      expectedIds
    );
  }

  it.each([
    ['name:""', [1]],
    ["name:''", [1]],
    ['name:null', [2]],
    ['name:!=""', [3, 4, 5, 6, 7, 8]],
    ['NOT name:""', [3, 4, 5, 6, 7, 8]],
    ['name:!=null', [1, 3, 4, 5, 6, 7, 8]],
    ['NOT name:null', [1, 3, 4, 5, 6, 7, 8]],
    ['name:*', [1, 3, 4, 5, 6, 7, 8]],
    ['NOT name:*', []],
    ['name:"" OR name:null', [1, 2]],
    ['name:"" AND name:null', []]
  ])(
    '%s keeps the empty string and null apart on every engine',
    (query, ids) => {
      expectIds(parser.parse(query), ids);
    }
  );

  it('matches only the empty string with an empty LIKE pattern', () => {
    expectIds(
      { type: 'comparison', field: 'name', operator: 'LIKE', value: '' },
      [1]
    );
  });
});
