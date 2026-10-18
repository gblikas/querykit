/**
 * Boolean range endpoint.
 *
 * The bracket rewrite leaves a range with an unquoted `true` or `false`
 * bound to Liqe, which rejects it, instead of comparing with the texts
 * `"true"` and `"false"`; the search box is incomplete for the same ranges.
 */

import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, active: false },
  { id: 2, active: true },
  { id: 3, active: 'true' }
];

describe('boolean range endpoint', () => {
  const parser = new QueryParser();

  it.each([
    'active:[false TO true]',
    'active:{false TO true}',
    'active:[false TO true}',
    'active:[true TO *]',
    'active:[* TO false]'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow('Syntax error at line 1 column');
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it('keeps quoted boolean bounds as strings', () => {
    const query = 'active:["false" TO "true"]';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({
      type: 'logical',
      operator: 'AND',
      left: { operator: '>=', value: 'false' },
      right: { operator: '<=', value: 'true' }
    });
  });

  it.each([
    ['active:false', [1]],
    ['active:[false, true]', [1, 2]]
  ])('keeps %p complete and executable', (query, ids) => {
    expect(isInputComplete(query)).toBe(true);
    expect(() => parser.parse(query)).not.toThrow();
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('keeps active:<=false one ordered comparison against false', () => {
    expect(isInputComplete('active:<=false')).toBe(true);
    expect(parser.parse('active:<=false')).toEqual({
      type: 'comparison',
      field: 'active',
      operator: '<=',
      value: false
    });
  });
});
