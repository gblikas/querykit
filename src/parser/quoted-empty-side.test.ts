/**
 * Quoted field names with an empty side of a dot.
 *
 * `"table.":open` and `".column":open` are the columns `table.` and
 * `.column`: a quoted name with one dot, other than `.`, is marked literal
 * and quoted as one identifier on every engine, so neither the closed
 * `table` and `column` columns nor an empty identifier is read.
 * `"table..column"` has two dots and was already one identifier.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { QueryExpression } from './types';
import { openSqliteHarness } from '../test-support';

type Row = Record<string, string | number>;

const closedColumns = ['table', 'column', 'b'];
const specialColumns = ['table.', '.column', 'table..column', 'column.', 'a.b'];

/** The closed columns are closed on every row; row n + 1 opens special n. */
function buildRows(): Row[] {
  const shut: Row = {};
  for (const column of closedColumns) {
    shut[column] = 'closed';
  }
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
const columns = [...closedColumns, ...specialColumns];

const a = sqliteTable('a', {
  id: integer('id'),
  ...Object.fromEntries(columns.map(column => [column, text(column)]))
});

function quoteName(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

describe('quoted field names with an empty side of a dot', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: a,
    columns: Object.fromEntries(columns.map(column => [column, 'TEXT'])),
    rows
  });

  it.each([
    ['"table.":open', 'table.', true, [1]],
    ["'table.':open", 'table.', true, [1]],
    ['".column":open', '.column', true, [2]],
    ["'.column':open", '.column', true, [2]],
    ['"table..column":open', 'table..column', false, [3]],
    ["'table..column':open", 'table..column', false, [3]],
    ['column.:open', 'column.', true, [4]],
    ['"a.b":open', 'a.b', true, [5]],
    ['table:open', 'table', false, []],
    ['column:open', 'column', false, []]
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

  it('still splits an unmarked name with an empty side', () => {
    const unmarked: QueryExpression = {
      type: 'comparison',
      field: 'table.',
      operator: '==',
      value: 'open'
    };
    expect(
      new SqlTranslator({ useParameters: false }).translate(unmarked)
    ).toBe(`"table"."" = 'open'`);
    expect(() => new DrizzleTranslator().translate(unmarked)).toThrow(
      'Invalid field name: table.'
    );
  });

  it('does not read column table or column in memory for a literal name', () => {
    const columnRows = [{ id: 1, table: 'open', column: 'open' }];
    expect(filterInMemory('"table.":open', columnRows)).toEqual([]);
    expect(filterInMemory('".column":open', columnRows)).toEqual([]);
  });
});
