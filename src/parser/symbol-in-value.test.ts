/**
 * Rejected value symbols.
 *
 * Liqe's unquoted value is `[#$*?@A-Z_a-z\u0080-\uFFFF][\w#$*.?@\u0080-\uFFFF\-]*`
 * and its number `-?\d+(\.\d+)?`. `%` and `=` are in neither set, and `-`
 * may only start a number, so `a%b`, `-x` and `a=b` are syntax errors
 * unless quoted. `a_b`, `a-b` and the wildcard `a*b` are values.
 */

import { filterInMemory } from '../adapters/memory';
import { withNulSafeLike } from '../translators/nul-safe-like';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a%b' },
  { id: 2, status: 'a_b' },
  { id: 3, status: 'a-b' },
  { id: 4, status: '-x' },
  { id: 5, status: 'a=b' },
  { id: 6, status: 'a&b' },
  { id: 7, status: 'axb' },
  { id: 8, status: 'ab' }
];

describe('symbol in value', () => {
  const parser = new QueryParser();

  it.each([
    'status:a%b',
    'status:-x',
    'status:a=b',
    'status:a&b',
    'status:>a%b',
    'status:!=-x',
    'status:a%b AND status:ab',
    'status:a+b',
    'status:a!b',
    'status:a,b',
    'status:a<b',
    'status:a\\b'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow('Syntax error at line 1 column');
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    expect(parser.parseWithContext(query).recovery?.autofix).toBeUndefined();
  });

  it.each([
    ['status:a_b', `"status" = 'a_b'`, [2]],
    ['status:a-b', `"status" = 'a-b'`, [3]],
    ['status:a*b', `"status" LIKE 'a%b' ESCAPE '!'`, [1, 2, 3, 5, 6, 7, 8]],
    ['status:"a%b"', `"status" = 'a%b'`, [1]],
    ['status:"-x"', `"status" = '-x'`, [4]],
    ["status:'a=b'", `"status" = 'a=b'`, [5]],
    ['status:"a&b"', `"status" = 'a&b'`, [6]],
    ['status:a#b', `"status" = 'a#b'`, []],
    ['status:a@b', `"status" = 'a@b'`, []],
    ['status:a$b', `"status" = 'a$b'`, []],
    ['status:a.b', `"status" = 'a.b'`, []],
    ['status:ü', `"status" = 'ü'`, []],
    ['status:#a', `"status" = '#a'`, []],
    ['status:$a', `"status" = '$a'`, []],
    ['status:@a', `"status" = '@a'`, []],
    ['status:_a', `"status" = '_a'`, []],
    ['status:a\u00a0b', `"status" = 'a\u00a0b'`, []]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(withNulSafeLike(sql));
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('keeps -status:open a negation of the open rows', () => {
    expect(isInputComplete('-status:open')).toBe(true);
    expect(filterInMemory('-status:open', rows)).toHaveLength(8);
  });
});
