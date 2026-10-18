/**
 * Quoted phrase.
 *
 * A quoted literal with no field is Liqe's implicit-field tag, which
 * QueryKit rejects. `"hello world"`, `'hello world'`, `""` and `''` are
 * incomplete and rejected; a quote attached to a field stays equality.
 */

import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, note: 'hello world', status: 'open' },
  { id: 2, note: '', status: 'done' },
  { id: 3, note: 'other', status: 'open' }
];

const IMPLICIT_FIELD =
  'Failed to parse query: Implicit field search is not supported; queries must name a field';

describe('quoted phrase', () => {
  const parser = new QueryParser();

  it.each([
    '"hello world"',
    "'hello world'",
    '""',
    "''",
    'status:done OR "hello world"',
    '("hello world")'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(IMPLICIT_FIELD);
    expect(() => filterInMemory(query, rows)).toThrow(IMPLICIT_FIELD);
  });

  it.each([
    ['note:"hello world"', 'hello world', [1]],
    ["note:'hello world'", 'hello world', [1]],
    ['note:""', '', [2]]
  ])('keeps %p as equality on note', (query, value, ids) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'note',
      operator: '==',
      value
    });
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('keeps an empty quoted field name as a field', () => {
    const emptyKeyRows = [
      { id: 1, '': 'a' },
      { id: 2, '': 'b' },
      { id: 3, '': 'a' }
    ];
    expect(isInputComplete('"":a')).toBe(true);
    expect(parser.parse('"":a')).toEqual({
      type: 'comparison',
      field: '',
      operator: '==',
      value: 'a'
    });
    expect(filterInMemory('"":a', emptyKeyRows).map(row => row.id)).toEqual([
      1, 3
    ]);
  });

  it('keeps a lowercase and after a quoted value an operator', () => {
    const query = 'note:"hello world" and status:open';
    expect(isInputComplete(query)).toBe(true);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([1]);
  });

  it.each(['hello', 'open done'])(
    'keeps the unquoted word %p incomplete and rejected',
    query => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(IMPLICIT_FIELD);
    }
  );
});
