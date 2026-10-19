/**
 * Quoted field names with a hyphen, a space, a percent sign, or a leading
 * digit.
 *
 * `"sta-tus":open`, `"sta tus":open`, `"sta%tus":open` and `"1status":open`
 * name columns spelled that way. Each mark stays inside the quoted
 * identifier on every engine; the percent sign is not a LIKE wildcard, the
 * bound parameter list stays `['open']`, and the normal `status` row is
 * never selected.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { isInputComplete } from './input-parser';
import { QueryParser } from './parser';
import { openSqliteHarness } from '../test-support';

type Row = Record<string, string | number>;

const specialColumns = ['sta-tus', 'sta tus', 'sta%tus', '1status'];

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

describe('quoted field names with a hyphen, space, percent or digit', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: Object.fromEntries(columns.map(column => [column, 'TEXT'])),
    rows
  });

  it.each([
    ['"sta-tus":open', 'sta-tus', 2],
    ['"sta tus":open', 'sta tus', 3],
    ['"sta%tus":open', 'sta%tus', 4],
    ['"1status":open', '1status', 5]
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
    expect(run.inlineSql).not.toContain('LIKE');
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
});
