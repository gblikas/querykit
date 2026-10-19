/**
 * Quoted field names that are only a symbol, a space, a dot, or a keyword.
 *
 * `"*":open`, `" ":open`, `".":open` and `"select":open` name columns
 * spelled that way. Each name is one identifier on every engine: the star
 * is not a LIKE wildcard, the dot is not an empty table and an empty column,
 * and the keyword is quoted, so it is not SQL syntax. `"":open` still
 * matches the empty-named column, and backtick names stay incomplete.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { openSqliteHarness } from '../test-support';

type Row = Record<string, string | number>;

const specialColumns = ['*', ' ', '.', 'select', ''];

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

describe('quoted field names that are only a symbol, space, dot or keyword', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: Object.fromEntries(columns.map(column => [column, 'TEXT'])),
    rows
  });

  it.each([
    ['"*":open', '*', [2]],
    ["'*':open", '*', [2]],
    ['" ":open', ' ', [3]],
    ["' ':open", ' ', [3]],
    ['".":open', '.', [4]],
    ["'.':open", '.', [4]],
    ['"select":open', 'select', [5]],
    ["'select':open", 'select', [5]],
    ['"":open', '', [6]],
    ["'':open", '', [6]],
    ['status:open', 'status', []]
  ])('%s selects only its own column', (query, field, expectedIds) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field,
      operator: '==',
      value: 'open'
    });
    const quoted = quoteName(field);
    const run = harness.expectSameIds(query, expectedIds);
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

  it.each(['`status`:open', '`sta tus`:open'])(
    '%s stays incomplete and rejected on every engine',
    query => {
      const message = 'Syntax error at line 1 column 1';
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => parser.parse(query)).toThrow(message);
      expect(() => filterInMemory(query, rows)).toThrow(message);
      const context = parser.parseWithContext(query);
      expect(context.success).toBe(false);
      expect(context.structure.isComplete).toBe(false);
      expect(context.ast).toBeUndefined();
      expect(context.recovery?.autofix).toBeUndefined();
    }
  );
});
