/**
 * Quoted field names with a space or a double quote.
 *
 * The parser accepts `"full name":alpha` as the field `full name` and
 * `"say\"hi":alpha` as the field `say"hi`. Every engine quotes the name as
 * one identifier, doubling an embedded quote so it cannot end the
 * identifier early, and Drizzle without a schema accepts the name instead
 * of rejecting it as an invalid field.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
import { openSqliteHarness } from '../test-support';

interface IRow {
  id: number;
  'full name': string | null;
  'say"hi': string | null;
}

const rows: IRow[] = [
  { id: 1, 'full name': 'alpha', 'say"hi': 'alpha' },
  { id: 2, 'full name': 'beta', 'say"hi': 'alpha' },
  { id: 3, 'full name': 'alpha', 'say"hi': 'beta' },
  { id: 4, 'full name': null, 'say"hi': null }
];

const items = sqliteTable('items', {
  id: integer('id'),
  'full name': text('full name'),
  'say"hi': text('say"hi')
});

describe('quoted field names with a space or a double quote', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { 'full name': 'TEXT', 'say"hi': 'TEXT' },
    rows
  });

  it.each([
    ['"full name":alpha', 'full name', '"full name"', [1, 3]],
    ['"say\\"hi":alpha', 'say"hi', '"say""hi"', [1, 2]]
  ])(
    '%s reads one identifier on every engine',
    (query, field, quoted, expectedIds) => {
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value: 'alpha'
      });
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.inlineSql).toBe(`${quoted} = 'alpha'`);
      expect(run.parameterized).toEqual({
        sql: `${quoted} = ?`,
        params: ['alpha']
      });
      expect(run.drizzle).toEqual({
        sql: `${quoted} = ?`,
        params: ['alpha']
      });
      expect(run.schemaDrizzle).toEqual({
        sql: `"items".${quoted} = ?`,
        params: ['alpha']
      });
    }
  );
});
