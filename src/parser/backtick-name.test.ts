/**
 * Backtick field names and an empty quoted name.
 *
 * Backticks are not identifier quotes: `` `status`:open `` is a syntax
 * error on every engine and the open `status` row is not selected by it.
 * `"":open` and `'':open` name the column whose name is empty; that name is
 * one identifier, written `""`, on every engine, including Drizzle without
 * a schema.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { QueryExpression } from './types';
import { openSqliteHarness } from '../test-support';

type Row = Record<string, string | number>;

const specialColumns = ['sta@tus', 'stätus', 'sta tus', ''];

/** Row 1 has the open status; row n + 2 is open in special column n only. */
function buildRows(): Row[] {
  const shut: Row = { id: 1, status: 'open' };
  for (const column of specialColumns) {
    shut[column] = 'shut';
  }
  return [
    shut,
    ...specialColumns.map((openColumn, index): Row => {
      const row: Row = { ...shut, id: index + 2, status: 'closed' };
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

describe('backtick field names and an empty quoted name', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: Object.fromEntries(columns.map(column => [column, 'TEXT'])),
    rows
  });

  it.each([
    ['"":open', '', 5],
    ["'':open", '', 5],
    ['"sta@tus":open', 'sta@tus', 2],
    ['"stätus":open', 'stätus', 3],
    ['"sta tus":open', 'sta tus', 4],
    ['status:open', 'status', 1]
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

  it('still rejects an empty part of a qualified name on Drizzle without a schema', () => {
    for (const field of ['table.', '.column']) {
      const expression: QueryExpression = {
        type: 'comparison',
        field,
        operator: '==',
        value: 'open'
      };
      expect(() => new DrizzleTranslator().translate(expression)).toThrow(
        `Invalid field name: ${field}`
      );
    }
  });
});
