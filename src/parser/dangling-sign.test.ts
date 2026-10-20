/**
 * Dangling and doubled signs.
 *
 * A minus with only a dot, and a second sign in front of digits, are not
 * Liqe decimals and are not spelled into one. The search box is incomplete
 * for them; `count:-` already found no parsing. Finished numbers agree.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, count: 1 },
  { id: 2, count: -1 },
  { id: 3, count: 2 }
];

describe('dangling signs', () => {
  const parser = new QueryParser();

  it.each([
    [
      'count:1',
      1,
      `("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = 1)`,
      [1]
    ],
    [
      'count:-1',
      -1,
      `("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = -1)`,
      [2]
    ],
    [
      'count:+1',
      1,
      `("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = 1)`,
      [1]
    ],
    [
      'count:02',
      2,
      `("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = 2)`,
      [3]
    ],
    [
      'count:-.1',
      -0.1,
      `("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = -0.1)`,
      []
    ]
  ])('keeps %p complete with value %p', (query, value, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ operator: '==', value });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each([
    ['count:-.', 'Syntax error at line 1 column 8'],
    ['count:++1', 'Syntax error at line 1 column 7'],
    ['count:+-1', 'Syntax error at line 1 column 7'],
    ['count:--1', 'Syntax error at line 1 column 8'],
    ['count:-', 'Found no parsings.'],
    ['count:+', 'Syntax error at line 1 column 7'],
    ['count:1e', 'Syntax error at line 1 column 8'],
    ['count:1.2.3', 'Syntax error at line 1 column 10']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });
});
