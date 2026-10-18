/**
 * Missing field or value.
 *
 * A colon with no field name is a Liqe syntax error. The search box used to
 * skip the colon and call `:a` and `:` complete. `status:` was already
 * incomplete, and `"":a` is a finished query on a field named `""`.
 */

import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, '': 'a', status: 'a' },
  { id: 2, '': 'b', status: 'b' }
];

describe('missing field', () => {
  const parser = new QueryParser();

  it.each([
    [':a', 'Syntax error at line 1 column 1'],
    [':', 'Syntax error at line 1 column 1'],
    ['(:a)', 'Syntax error at line 1 column 2'],
    ['status:a OR :b', 'Syntax error at line 1 column']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it('keeps status: incomplete with the empty-tag error', () => {
    expect(isInputComplete('status:')).toBe(false);
    expect(() => parser.parse('status:')).toThrow(
      'Invalid field or expression in Tag node'
    );
    expect(() => filterInMemory('status:', rows)).toThrow(QueryParseError);
  });

  it('keeps "":a as equality on the empty field name', () => {
    expect(isInputComplete('"":a')).toBe(true);
    expect(parser.parse('"":a')).toEqual({
      type: 'comparison',
      field: '',
      operator: '==',
      value: 'a'
    });
    expect(filterInMemory('"":a', rows).map(row => row.id)).toEqual([1]);
  });

  it.each([
    ['status:a', 'a'],
    ['status:[:a]', ':a'],
    ['or:a', 'a']
  ])('keeps %p complete with the colon in place', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: '==', value });
  });

  it('keeps a colon inside quotes in the value', () => {
    expect(isInputComplete('note:"a : b"')).toBe(true);
    expect(parser.parse('note:"a : b"')).toMatchObject({
      field: 'note',
      value: 'a : b'
    });
  });
});
