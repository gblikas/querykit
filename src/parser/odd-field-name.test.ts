/**
 * Quoted field names with driver marks.
 *
 * `"?status":open`, `"sta$tus":open` and `"sta:tus":open` name columns whose
 * names hold the marks drivers use for placeholders. Each mark stays inside
 * the quoted identifier on every engine, the bound parameter list stays
 * `['open']`, and the normal `status` row is never selected. Unquoted
 * `sta?tus:open` stays incomplete.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { openSqliteHarness } from '../test-support';

type Row = Record<string, string | number>;

const specialColumns = ['?status', 'sta$tus', 'sta:tus', 'sta?tus'];

/** Row 1 is shut everywhere; row n + 2 is open in special column n only. */
function buildRows(): Row[] {
  const shut: Row = { id: 1, status: 'closed' };
  for (const column of specialColumns) {
    shut[column] = 'shut';
  }
  return [
    shut,
    ...specialColumns.map((openColumn, index): Row => {
      const row: Row = { ...shut, id: index + 2 };
      row[openColumn] = 'open';
      return row;
    })
  ];
}

const rows = buildRows();

const items = sqliteTable('items', {
  id: integer('id'),
  status: text('status'),
  ...Object.fromEntries(specialColumns.map(column => [column, text(column)]))
});

function quoteName(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

const columns = ['status', ...specialColumns];

describe('quoted field names with driver marks', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: Object.fromEntries(columns.map(column => [column, 'TEXT'])),
    rows
  });

  it.each([
    ['"?status":open', '?status', 2],
    ['"sta$tus":open', 'sta$tus', 3],
    ['"sta:tus":open', 'sta:tus', 4],
    ['"sta?tus":open', 'sta?tus', 5]
  ])('%s selects only its own column', (query, field, expectedId) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field,
      operator: '==',
      value: 'open'
    });
    const quoted = quoteName(field);
    const run = harness.expectSameIds(query, [expectedId]);
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
      sql: `"items".${quoted} = ?`,
      params: ['open']
    });
  });

  it('keeps unquoted sta?tus:open incomplete and rejected', () => {
    const query = 'sta?tus:open';
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(
      'Syntax error at line 1 column 8'
    );
    expect(() => filterInMemory(query, rows)).toThrow(
      'Syntax error at line 1 column 8'
    );
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.ast).toBeUndefined();
    expect(context.recovery?.autofix).toBeUndefined();
  });
});
