/**
 * Unquoted field names with an empty side of a dot.
 *
 * `.column:open` is a syntax error and incomplete; no engine rewrites it to
 * `column:open`. `column.:open` is the column `column.`: an unquoted name
 * with one dot and an empty side is marked literal and quoted as one
 * identifier on every engine. `a..b` has two dots and is one identifier
 * already; it never reads column `b`.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { openSqliteHarness } from '../test-support';

type Row = Record<string, string | number>;

const columns = ['column', 'b', 'column.', 'a..b', 'a.b', '.'];

/** Row n + 1 is open in column n and shut everywhere else. */
function buildRows(): Row[] {
  const shut: Row = {};
  for (const column of columns) {
    shut[column] = 'shut';
  }
  return columns.map((openColumn, index): Row => {
    const row: Row = { ...shut, id: index + 1 };
    row[openColumn] = 'open';
    return row;
  });
}

const rows = buildRows();

const a = sqliteTable('a', {
  id: integer('id'),
  ...Object.fromEntries(columns.map(column => [column, text(column)]))
});

function quoteName(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

describe('unquoted field names with an empty side of a dot', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: a,
    columns: Object.fromEntries(columns.map(column => [column, 'TEXT'])),
    rows
  });

  it('keeps .column:open incomplete and rejected without an autofix', () => {
    const query = '.column:open';
    const message = 'Syntax error at line 1 column 1';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it.each([
    ['column.:open', 'column.', true, [3]],
    ['a..b:open', 'a..b', false, [4]],
    ['"a.b":open', 'a.b', true, [5]],
    ['".":open', '.', false, [6]]
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
    const run = harness.expectSameSqlIds(query, [2]);
    expect(run.inlineSql).toBe(`"a"."b" = 'open'`);
    expect(run.schemaDrizzle).toEqual({
      sql: '"a"."b" = ?',
      params: ['open']
    });
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([5]);
  });

  it('drops the literal flag when a field mapping replaces the name', () => {
    const expression = new QueryParser({
      fieldMappings: { 'column.': 'b' }
    }).parse('column.:open');
    expect(expression).toEqual({
      type: 'comparison',
      field: 'b',
      operator: '==',
      value: 'open'
    });
    const mappedByTranslator = new SqlTranslator({
      useParameters: false,
      fieldMappings: { 'column.': 'a.b' }
    }).translate(parser.parse('column.:open'));
    expect(mappedByTranslator).toBe(`"a"."b" = 'open'`);
  });

  it('does not read column column in memory for the literal column.', () => {
    const columnRows = [{ id: 1, column: 'open' }];
    expect(filterInMemory('column.:open', columnRows)).toEqual([]);
  });

  it('reads the renamed column in memory when a mapping drops the flag', () => {
    const columnRows = [
      { id: 1, b: 'open' },
      { id: 2, b: 'closed' }
    ];
    expect(
      filterInMemory('column.:open', columnRows, {
        fieldMappings: { 'column.': 'a.b' }
      }).map(row => row.id)
    ).toEqual([1]);
  });
});
