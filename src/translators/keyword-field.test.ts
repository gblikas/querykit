/**
 * Keyword field names.
 *
 * `order:a`, `select:a`, `group:a` and `where:1` name columns spelled as
 * SQL keywords. Every engine quotes the identifier, so none of them is a
 * syntax error, and all of them return the same ids.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
import { openSqliteHarness } from '../test-support';

const rows = [
  { id: 1, order: 'a', select: 'a', group: 'a', where: 1 },
  { id: 2, order: 'b', select: 'a', group: 'c', where: 1 },
  { id: 3, order: 'a', select: 'b', group: 'a', where: 2 },
  { id: 4, order: null, select: null, group: null, where: null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  order: text('order'),
  select: text('select'),
  group: text('group'),
  where: integer('where')
});

describe('keyword field names', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { order: 'TEXT', select: 'TEXT', group: 'TEXT', where: 'INTEGER' },
    rows
  });

  it.each([
    ['order:a', 'order', 'a', `'a'`, [1, 3]],
    ['select:a', 'select', 'a', `'a'`, [1, 2]],
    ['group:a', 'group', 'a', `'a'`, [1, 3]],
    ['where:1', 'where', 1, '1', [1, 2]]
  ])(
    '%s quotes the keyword on every engine',
    (query, field, value, inlineValue, expectedIds) => {
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value
      });
      const run = harness.expectSameIds(query, expectedIds);
      const quoted = `"${field}"`;
      const inlineSql =
        typeof value === 'number'
          ? `(${quoted} IS NULL AND NULL) OR (typeof(${quoted}) IN ('integer', 'real') AND ${quoted} = ${inlineValue})`
          : `${quoted} = ${inlineValue}`;
      expect(run.inlineSql).toBe(inlineSql);
      expect(run.parameterized).toEqual({
        sql: `"${field}" = ?`,
        params: [value]
      });
      expect(run.drizzle).toEqual({
        sql: `"${field}" = ?`,
        params: [value]
      });
      expect(run.schemaDrizzle).toEqual({
        sql: `"items"."${field}" = ?`,
        params: [value]
      });
    }
  );

  it('would be a syntax error without the quotes', () => {
    for (const keyword of ['order', 'select', 'group', 'where']) {
      expect(() =>
        harness.database.prepare(`SELECT id FROM items WHERE ${keyword} = 'a'`)
      ).toThrow(`near "${keyword}": syntax error`);
    }
  });
});
