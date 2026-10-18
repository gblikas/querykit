/**
 * Dangling AND/OR.
 *
 * An `AND` or `OR` with no clause on one side, or with another `AND`/`OR`
 * between it and a clause, is rejected by Liqe. The search box only looked
 * for a trailing operator word. `NOT` may still sit on the right of `AND`.
 */

import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a' },
  { id: 2, status: 'b' }
];

describe('dangling operators', () => {
  const parser = new QueryParser();

  it.each([
    ['status:a AND', 'Found no parsings.'],
    ['status:a OR', 'Found no parsings.'],
    ['AND status:a', 'Syntax error at line 1 column 4'],
    ['OR status:a', 'Syntax error at line 1 column 3'],
    ['status:a AND AND status:b', 'Syntax error at line 1 column 17'],
    ['and status:a', 'Syntax error at line 1 column 4'],
    ['status:a and and status:b', 'Syntax error at line 1 column 17'],
    ['(AND status:a)', 'Syntax error at line 1 column'],
    ['(status:a AND)', 'Syntax error at line 1 column'],
    ['status:a AND ()', 'Invalid empty expression'],
    ['() AND status:a', 'Invalid empty expression']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  // `and.status` is one field, a single `table.column`; with no own key of
  // that name the in-memory reader reads the column `status`.
  it.each([
    ['status:a AND NOT status:b', [1]],
    ['and.status:a', [1]],
    ['status:a AND and.status:b', []],
    ['status:a AND(status:b)', []],
    ['note:"AND status:a" OR status:a', [1]]
  ])('keeps %p complete and executable', (query, ids) => {
    expect(isInputComplete(query)).toBe(true);
    expect(() => parser.parse(query)).not.toThrow();
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });
});
