/**
 * A question mark in a field name.
 *
 * `"sta?tus":open` and `'sta?tus':open` parse as a comparison on the field
 * `sta?tus`. The mark stays inside the quoted identifier on every engine,
 * is not a bind parameter, and is not dropped to make the query
 * `status:open`. Unquoted forms with a stray `?` stay incomplete, and a
 * `?` in a value stays a one-character wildcard.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { openSqliteHarness } from '../test-support';

const rows = [
  { id: 1, status: 'open', 'sta?tus': 'shut' },
  { id: 2, status: 'openX', 'sta?tus': 'open' }
];

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  'sta?tus': text('sta?tus')
});

describe('question mark in a field name', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { status: 'TEXT', 'sta?tus': 'TEXT' },
    rows
  });

  it.each(['"sta?tus":open', "'sta?tus':open"])(
    '%s keeps the question mark inside the quoted identifier',
    query => {
      expect(isInputComplete(query)).toBe(true);
      expect(parser.parse(query)).toEqual({
        type: 'comparison',
        field: 'sta?tus',
        operator: '==',
        value: 'open'
      });
      const run = harness.expectSameIds(query, [2]);
      expect(run.inlineSql).toBe(`"sta?tus" = 'open'`);
      expect(run.parameterized).toEqual({
        sql: '"sta?tus" = ?',
        params: ['open']
      });
      expect(run.drizzle).toEqual({ sql: '"sta?tus" = ?', params: ['open'] });
      expect(run.schemaDrizzle).toEqual({
        sql: '"items"."sta?tus" = ?',
        params: ['open']
      });
    }
  );

  it.each([
    ['sta?tus:open', 'Syntax error at line 1 column 8'],
    ['status:open AND ?', 'Implicit field search is not supported'],
    ['(?status:open)', 'Syntax error at line 1 column 9'],
    ['?status:open', 'Syntax error at line 1 column 8']
  ])('%s stays incomplete and is not rewritten', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.ast).toBeUndefined();
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it.each([
    ['status:open?', 'open?', 'open_', [2]],
    ['status:?open', '?open', '_open', []]
  ])(
    '%s keeps the question mark as a one-character wildcard',
    (query, value, pattern, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      expect(parser.parse(query)).toEqual({
        type: 'comparison',
        field: 'status',
        operator: 'LIKE',
        value
      });
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.inlineSql).toBe(`"status" LIKE '${pattern}' ESCAPE '!'`);
      expect(run.parameterized).toEqual({
        sql: `"status" LIKE ? ESCAPE '!'`,
        params: [pattern]
      });
      expect(run.drizzle).toEqual({
        sql: `"status" LIKE ? ESCAPE '!'`,
        params: [pattern]
      });
      expect(run.schemaDrizzle).toEqual({
        sql: `"items"."status" LIKE ? ESCAPE '!'`,
        params: [pattern]
      });
    }
  );
});
