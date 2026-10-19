/**
 * Quoted field names that contain a dot.
 *
 * `"a.b":open` is the column `a.b`, not table `a` column `b`: a quoted name
 * with one dot is marked literal by the parser and quoted as one identifier
 * by every engine. `"a.b.c"`, `".."` and `"."` were already one identifier
 * because they are not a single `table.column`. Unquoted `a.b` stays a
 * qualifier on SQL and Drizzle, while memory reads the own key.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { openSqliteHarness } from '../test-support';

type Row = Record<string, string | number>;

const specialColumns = ['a.b', 'a.b.c', '..', '.'];

/** Column `b` is closed on every row; row n + 1 is open in special column n. */
function buildRows(): Row[] {
  const shut: Row = { b: 'closed' };
  for (const column of specialColumns) {
    shut[column] = 'shut';
  }
  return specialColumns.map((openColumn, index): Row => {
    const row: Row = { ...shut, id: index + 1 };
    row[openColumn] = 'open';
    return row;
  });
}

const rows = buildRows();

const a = sqliteTable('a', {
  id: integer('id'),
  b: text('b'),
  ...Object.fromEntries(specialColumns.map(column => [column, text(column)]))
});

function quoteName(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

const columns = ['b', ...specialColumns];

describe('quoted field names that contain a dot', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: a,
    columns: Object.fromEntries(columns.map(column => [column, 'TEXT'])),
    rows
  });

  it.each([
    ['"a.b":open', 'a.b', true, [1]],
    ["'a.b':open", 'a.b', true, [1]],
    ['"a.b.c":open', 'a.b.c', false, [2]],
    ["'a.b.c':open", 'a.b.c', false, [2]],
    ['"..":open', '..', false, [3]],
    ["'..':open", '..', false, [3]],
    ['".":open', '.', false, [4]],
    ["'.':open", '.', false, [4]]
  ])(
    '%s is one identifier on every engine',
    (query, field, isLiteral, expectedIds) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: '==',
        value: 'open',
        ...(isLiteral ? { isLiteral: true } : {})
      });
      const quoted = quoteName(field);
      const run = harness.expectSameIds(query, expectedIds);
      expect(run.inlineSql).toBe(`${quoted} = 'open'`);
      expect(run.parameterized).toEqual({
        sql: `${quoted} = ?`,
        params: ['open']
      });
      expect(run.drizzle).toEqual({
        sql: `${quoted} = ?`,
        params: ['open']
      });
      expect(run.schemaDrizzle).toEqual({
        sql: `"a".${quoted} = ?`,
        params: ['open']
      });
    }
  );

  it('keeps unquoted a.b a qualifier on SQL and Drizzle while memory reads the own key', () => {
    const query = 'a.b:open';
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field: 'a.b',
      operator: '==',
      value: 'open'
    });
    const run = harness.expectSameSqlIds(query, []);
    expect(run.inlineSql).toBe(`"a"."b" = 'open'`);
    expect(run.parameterized).toEqual({ sql: '"a"."b" = ?', params: ['open'] });
    expect(run.drizzle).toEqual({
      sql: '"a"."b" = ?',
      params: ['open']
    });
    expect(run.schemaDrizzle).toEqual({
      sql: '"a"."b" = ?',
      params: ['open']
    });
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([1]);
  });

  it('does not read column b in memory for a literal name without an own key', () => {
    const columnRows = [
      { id: 1, b: 'open' },
      { id: 2, b: 'closed' }
    ];
    expect(filterInMemory('"a.b":open', columnRows)).toEqual([]);
    expect(filterInMemory('a.b:open', columnRows).map(row => row.id)).toEqual([
      1
    ]);
  });

  it('keeps unquoted table. one identifier', () => {
    const expression = parser.parse('table.:open');
    expect(expression).toEqual({
      type: 'comparison',
      field: 'table.',
      operator: '==',
      value: 'open',
      isLiteral: true
    });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"table." = 'open'`);
    expect(harness.compileDrizzle(expression)).toEqual({
      sql: '"table." = ?',
      params: ['open']
    });
  });

  it('keeps unquoted .column incomplete and rejected', () => {
    const query = '.column:open';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(
      'Syntax error at line 1 column 1'
    );
    expect(() => filterInMemory(query, rows)).toThrow(
      'Syntax error at line 1 column 1'
    );
  });
});
