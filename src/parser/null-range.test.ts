/**
 * Null range endpoint.
 *
 * No engine orders a column against null, so the bracket rewrite leaves a
 * range with an unquoted `null` bound to Liqe, which rejects it, and the
 * search box is incomplete for the same ranges. A quoted `"null"` is still
 * a string bound.
 */

import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, priority: null },
  { id: 2, priority: 1 },
  { id: 3, priority: 2 },
  { id: 4, priority: 3 }
];

describe('null range endpoint', () => {
  const parser = new QueryParser();

  it.each([
    ['priority:[null TO 3]', 'Syntax error at line 1 column 11'],
    ['priority:[1 TO null]', 'Syntax error at line 1 column 16'],
    ['priority:{null TO 3}', 'Syntax error at line 1 column 11'],
    ['priority:[null TO *]', 'Syntax error at line 1 column 11'],
    ['priority:[* TO null]', 'Syntax error at line 1 column'],
    ['priority:[null TO null]', 'Syntax error at line 1 column 11']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it('keeps a quoted null bound as a string', () => {
    expect(isInputComplete('priority:["null" TO 3]')).toBe(true);
    expect(parser.parse('priority:["null" TO 3]')).toMatchObject({
      type: 'logical',
      operator: 'AND',
      left: { operator: '>=', value: 'null' },
      right: { operator: '<=', value: 3 }
    });
  });

  it.each([
    ['priority:<=null', []],
    ['priority:in[1, null]', [1, 2]],
    ['priority:[null]', [1]],
    ['priority:[1 TO 3]', [2, 3, 4]]
  ])('keeps %p complete and executable', (query, ids) => {
    expect(isInputComplete(query)).toBe(true);
    expect(() => parser.parse(query)).not.toThrow();
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });
});
