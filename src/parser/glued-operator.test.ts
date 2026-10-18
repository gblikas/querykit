/**
 * Glued operator.
 *
 * A `&&` or `||` glued to the next clause, or standing first inside a
 * parenthesis group, is a Liqe syntax error. The scanner used to skip the
 * symbols, so `&&status:open` looked like `status:open` and
 * `(&& status:open)` like `(status:open)`. The symbol is not removed.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open' },
  { id: 2, status: 'done' }
];

describe('glued operator', () => {
  const parser = new QueryParser();

  it.each([
    ['&&status:open', 'Syntax error at line 1 column 1'],
    ['||status:open', 'Syntax error at line 1 column 1'],
    ['(&& status:open)', 'Syntax error at line 1 column 2'],
    ['(|| status:open)', 'Syntax error at line 1 column 2'],
    ['(&&status:open)', 'Syntax error at line 1 column 2'],
    ['(||status:open)', 'Syntax error at line 1 column 2'],
    ['( && status:open)', 'Syntax error at line 1 column 3'],
    ['(\t|| status:open)', 'Syntax error at line 1 column 3'],
    [' (&& status:open)', 'Syntax error at line 1 column 3'],
    ['((&& status:open))', 'Syntax error at line 1 column 3'],
    ['(&&)', 'Syntax error at line 1 column 2'],
    ['(||)', 'Syntax error at line 1 column 2'],
    ['(&& )', 'Syntax error at line 1 column 2'],
    ['( &&)', 'Syntax error at line 1 column 3']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    expect(parser.parseWithContext(query).recovery?.autofix).toBeUndefined();
  });

  it.each([
    ['(status:open)', `"status" = 'open'`, [1]],
    ['((status:open))', `"status" = 'open'`, [1]],
    [
      '(status:open OR status:done)',
      `("status" = 'open') OR ("status" = 'done')`,
      [1, 2]
    ],
    ['NOT (status:open)', `NOT ("status" = 'open')`, [2]],
    [
      'status:open AND (status:done)',
      `("status" = 'open') AND ("status" = 'done')`,
      []
    ]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each([
    ['status:"&&status:open"', '&&status:open'],
    ['status:"(&& status:open)"', '(&& status:open)'],
    ["status:'(|| status:open)'", '(|| status:open)']
  ])('keeps %p as the quoted value %p', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ operator: '==', value });
    expect(
      new SqlTranslator({ useParameters: true }).translate(expression)
    ).toEqual({ sql: '"status" = ?', params: [value] });
    expect(filterInMemory(query, rows)).toEqual([]);
  });

  it.each(['name:/&&/', 'name:/(&&)/', 'name:/(||)/'])(
    'keeps %p a regex',
    query => {
      expect(isInputComplete(query)).toBe(true);
      expect(parser.parse(query)).toMatchObject({ operator: 'REGEX' });
    }
  );
});
