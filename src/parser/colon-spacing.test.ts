/**
 * Spaces around the field colon.
 *
 * Only `status:a` names the field `status`. A space before the colon is a
 * Liqe syntax error, and the search box used to read `status :a` as two bare
 * words and call it complete. The spaced forms are not rewritten into
 * `status:a`.
 */

import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a' },
  { id: 2, status: 'b' },
  { id: 3, status: ' a' },
  { id: 4, status: 'a ' }
];

describe('colon spacing', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();

  it('keeps status:a as the field status with value a', () => {
    expect(isInputComplete('status:a')).toBe(true);
    const expression = parser.parse('status:a');
    expect(expression).toEqual({
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: 'a'
    });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"status" = 'a'`);
    const drizzle = dialect.sqlToQuery(
      new DrizzleTranslator().translate(expression)
    );
    expect(drizzle).toMatchObject({ sql: '"status" = ?', params: ['a'] });
    expect(filterInMemory('status:a', rows).map(row => row.id)).toEqual([1]);
  });

  it('keeps status: a incomplete with the empty-tag error', () => {
    expect(isInputComplete('status: a')).toBe(false);
    expect(() => parser.parse('status: a')).toThrow(
      'Invalid field or expression in Tag node'
    );
  });

  it.each([
    ['status : a', 'Syntax error at line 1 column 8'],
    ['status :a', 'Syntax error at line 1 column 8'],
    ['status\t:a', 'Syntax error at line 1 column 8'],
    ['status:a AND priority :b', 'Syntax error at line 1 column']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it('leaves a colon inside brackets and quotes in the value', () => {
    expect(isInputComplete('status:[a : b]')).toBe(true);
    expect(parser.parse('status:[a : b]')).toEqual({
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: 'a : b'
    });
    expect(
      new SqlTranslator({ useParameters: false }).translate(
        parser.parse('status:[a : b]')
      )
    ).toBe(`"status" = 'a : b'`);
    expect(filterInMemory('status:[a : b]', rows)).toEqual([]);
    expect(isInputComplete('note:"a : b"')).toBe(true);
    expect(parser.parse('note:"a : b"')).toMatchObject({
      field: 'note',
      value: 'a : b'
    });
  });
});
