/**
 * Unmatched parentheses.
 *
 * Parenthesis counts already decided `status:a)` and `(status:a`. An empty
 * group such as `()` or `NOT ()` has matching counts, so the search box
 * called it complete while the parser rejected it. A close before an open
 * is rejected the same way.
 */

import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a' },
  { id: 2, status: 'b' }
];

describe('unmatched parentheses', () => {
  const parser = new QueryParser();

  it.each([
    ['status:a)', 'Syntax error at line 1 column 9'],
    ['(status:a', 'Found no parsings.'],
    ['((status:a)', 'Found no parsings.'],
    ['()', 'Invalid empty expression'],
    ['NOT ()', 'Syntax error at line 1 column 6'],
    ['( )', 'Invalid empty expression'],
    ['(())', 'Invalid empty expression'],
    ['status:a AND ()', 'Invalid empty expression'],
    ['status:a)(', 'Syntax error at line 1 column 9'],
    [')(', 'Syntax error at line 1 column 1']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it.each([
    ['(status:a)', [1]],
    ['NOT (status:a OR status:b)', []],
    ['status:"()"', []]
  ])('keeps %p complete and executable', (query, ids) => {
    expect(isInputComplete(query)).toBe(true);
    expect(() => parser.parse(query)).not.toThrow();
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });
});
