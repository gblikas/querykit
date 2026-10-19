/**
 * Quoted field names with any identifier contents.
 *
 * A quoted field name's contents are the identifier. `@`, `*`, `/`, `+` and
 * a non-ASCII letter are not members of an allowlist of marks; the name is
 * accepted because it round-trips through identifier quoting, with a quote
 * character written twice. `;` and a null byte stay rejected on Drizzle
 * without a schema. `"sta""tus":open` is a syntax error, so the column
 * `sta"tus` is not selected by that spelling.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { QueryExpression } from './types';
import { openSqliteHarness } from '../test-support';

type Row = Record<string, string | number>;

const specialColumns = [
  'sta@tus',
  'sta*tus',
  'sta/tus',
  'sta+tus',
  'stätus',
  'sta"tus',
  '?status',
  'sta$tus',
  'sta:tus',
  'sta-tus',
  'sta%tus',
  '1status',
  'sta tus'
];

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

describe('quoted field names with any identifier contents', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: Object.fromEntries(columns.map(column => [column, 'TEXT'])),
    rows
  });

  it.each([
    ['"sta@tus":open', 'sta@tus', 2],
    ['"sta*tus":open', 'sta*tus', 3],
    ['"sta/tus":open', 'sta/tus', 4],
    ['"sta+tus":open', 'sta+tus', 5],
    ['"stätus":open', 'stätus', 6],
    ['"?status":open', '?status', 8],
    ['"sta$tus":open', 'sta$tus', 9],
    ['"sta:tus":open', 'sta:tus', 10],
    ['"sta-tus":open', 'sta-tus', 11],
    ['"sta%tus":open', 'sta%tus', 12],
    ['"1status":open', '1status', 13],
    ['"sta tus":open', 'sta tus', 14]
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

  it.each([
    ['"sta""tus":open', 'Syntax error at line 1 column 6'],
    ['sta?tus:open', 'Syntax error at line 1 column 8']
  ])('%s stays incomplete and rejected', (query, message) => {
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
    ['sta;tus', 'a semicolon'],
    ['sta\u0000tus', 'a null byte'],
    ['sta__tus', 'a reserved double underscore'],
    ['s'.repeat(65), 'more than 64 characters']
  ])('still rejects %p (%s) on Drizzle without a schema', field => {
    const expression: QueryExpression = {
      type: 'comparison',
      field,
      operator: '==',
      value: 'open'
    };
    expect(() => new DrizzleTranslator().translate(expression)).toThrow(
      `Invalid field name: ${field}`
    );
  });
});
