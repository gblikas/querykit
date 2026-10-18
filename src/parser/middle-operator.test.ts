/**
 * Middle operator.
 *
 * Any `&&` or `||` outside quotes and regex is a Liqe syntax error, whether
 * glued to a value or between two clauses. The word operators still agree
 * on every engine. The symbol stays in the text and is not compiled as
 * `AND` or `OR`.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open', label: 'a' },
  { id: 2, status: 'open', label: 'b' },
  { id: 3, status: 'done', label: 'a' }
];

describe('middle operator', () => {
  const parser = new QueryParser();

  it.each([
    ['status:open&&', 'Syntax error at line 1 column 12'],
    ['status:open||', 'Syntax error at line 1 column 12'],
    ['status:open && label:a', 'Syntax error at line 1 column 13'],
    ['status:open || label:a', 'Syntax error at line 1 column 13'],
    ['status:open&&label:a', 'Syntax error at line 1 column 12'],
    ['status:open&& label:a', 'Syntax error at line 1 column 12'],
    ['status:open &&label:a', 'Syntax error at line 1 column 13'],
    ['(status:open && label:a)', 'Syntax error at line 1 column 14'],
    ['status:open||label:a', 'Syntax error at line 1 column 12'],
    ['(status:open &&)', 'Syntax error at line 1 column 14'],
    ['(status:open || label:a)', 'Syntax error at line 1 column 14']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    expect(parser.parseWithContext(query).recovery?.autofix).toBeUndefined();
  });

  it.each([
    [
      'status:open AND label:a',
      `("status" = 'open') AND ("label" = 'a')`,
      ['open', 'a'],
      [1]
    ],
    [
      'status:open OR label:a',
      `("status" = 'open') OR ("label" = 'a')`,
      ['open', 'a'],
      [1, 2, 3]
    ],
    ['status:open', `"status" = 'open'`, ['open'], [1, 2]]
  ])('keeps %p complete and agreed', (query, sql, params, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(
      (
        new SqlTranslator({ useParameters: true }).translate(expression) as {
          params: unknown[];
        }
      ).params
    ).toEqual(params);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each([
    ['status:"open&&"', 'open&&'],
    ["status:'open||'", 'open||'],
    ['status:"open&&label:a"', 'open&&label:a']
  ])('keeps %p as the quoted value %p', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: '==', value });
    expect(filterInMemory(query, rows)).toEqual([]);
  });

  it.each(['name:/&&/', 'name:/||/', 'name:/foo&&bar/'])(
    'keeps %p a regex',
    query => {
      expect(isInputComplete(query)).toBe(true);
      expect(parser.parse(query)).toMatchObject({ operator: 'REGEX' });
    }
  );
});
