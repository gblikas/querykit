/**
 * A missing field name.
 *
 * `:todo` and `status:` do not parse. `"":todo` names the column `""`.
 * That name stays in the field list the search box checks, so a schema
 * that only declares `status` does not call the query valid and does not
 * suggest `status`. When the column `""` is present, every engine reads
 * it and leaves the `status` row out.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from '../parser/input-parser';
import { QueryParseError, QueryParser } from '../parser/parser';
import { IFieldSchema } from '../parser/types';
import { openSqliteHarness } from '../test-support';
import { DrizzleTranslator } from './drizzle';
import { SqlTranslator } from './sql';

interface IRow {
  id: number;
  status: string;
  '': string;
}

const rows: IRow[] = [
  { id: 1, status: 'todo', '': 'done' },
  { id: 2, status: 'done', '': 'todo' }
];

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  status: text('status'),
  '': text('')
});

const statusSchema: Record<string, IFieldSchema> = {
  status: { type: 'string', allowedValues: ['todo', 'done'] }
};

const SYNTAX_ERROR =
  'Failed to parse query: Syntax error at line 1 column 1';
const EMPTY_TAG =
  'Failed to parse query: Invalid field or expression in Tag node';
const NOT_ALLOWED = 'Invalid query parameters';

describe('a missing field name', () => {
  const parser = new QueryParser();
  const harness = openSqliteHarness({
    table: items,
    columns: { status: 'TEXT', '': 'TEXT' },
    rows
  });

  it.each([
    [':todo', SYNTAX_ERROR],
    ['status:', EMPTY_TAG]
  ])('%s is incomplete and every engine throws %s', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(message);
    expect(() => harness.compile(query)).toThrow(message);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it('reads "":todo from the empty column on every engine', () => {
    expect(isInputComplete('"":todo')).toBe(true);
    expect(parser.parse('"":todo')).toEqual({
      type: 'comparison',
      field: '',
      operator: '==',
      value: 'todo'
    });
    const run = harness.expectSameIds('"":todo', [2]);
    expect(run.inlineSql).toBe(`"" = 'todo'`);
    expect(run.parameterized).toEqual({ sql: '"" = ?', params: ['todo'] });
    expect(run.drizzle).toEqual({ sql: '"" = ?', params: ['todo'] });
    expect(run.schemaDrizzle.sql).toBe(`"items"."" = ?`);
    expect(filterInMemory('status:todo', rows).map(row => row.id)).toEqual([1]);
  });

  it('keeps the empty name in the field list and does not suggest status', () => {
    const result = parser.parseWithContext('"":todo', {
      schema: statusSchema,
      securityOptions: { allowedFields: ['status'] }
    });
    expect(result.success).toBe(true);
    expect(result.structure.isComplete).toBe(true);
    expect(result.structure.referencedFields).toEqual(['']);
    expect(result.security?.passed).toBe(false);
    expect(result.security?.violations).toEqual([
      {
        type: 'field_not_allowed',
        message: 'Field "" is not in the list of allowed fields',
        field: ''
      }
    ]);
    expect(result.fieldValidation?.valid).toBe(false);
    expect(result.fieldValidation?.unknownFields).toEqual(['']);
    expect(result.fieldValidation?.fields).toEqual([
      { field: '', valid: false, reason: 'unknown_field' }
    ]);
    const expression = parser.parse('"":todo');
    expect(() =>
      new SqlTranslator({ allowedFields: ['status'] }).translate(expression)
    ).toThrow(NOT_ALLOWED);
    expect(() =>
      new DrizzleTranslator({ allowedFields: ['status'] }).translate(expression)
    ).toThrow(NOT_ALLOWED);
    expect(() =>
      filterInMemory('"":todo', rows, undefined, { allowedFields: ['status'] })
    ).toThrow(NOT_ALLOWED);
  });
});
