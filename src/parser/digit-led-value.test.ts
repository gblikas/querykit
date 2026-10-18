/**
 * Digit-led values and glued literal starts.
 *
 * Liqe's unquoted value cannot start with a digit, and its decimal stops at
 * the first character that is not a digit or one dot, so `1x`, `2nd` and a
 * date are syntax errors unless quoted. A quote or slash glued to a value is
 * a syntax error too. Inside a membership list or a range the parser quotes
 * the member, so those stay complete.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a', label: '1x', count: 1 },
  { id: 2, status: '2nd', label: '2024-01-01', count: 2 },
  { id: 3, status: 'a"b"', label: 'x', count: 1 },
  { id: 4, status: 'a/b/', label: 'y', count: 3 },
  { id: 5, status: 'a', label: 'y', count: 1 }
];

describe('digit-led value', () => {
  const parser = new QueryParser();

  it.each([
    'label:1x',
    'status:2nd',
    'status:a"b"',
    'status:a/b/',
    '/a/',
    'status:1a',
    'status:1st',
    'status:12x',
    'status:1x2',
    'status:1-a',
    'status:1-',
    'status:1.5x',
    'status:1.a',
    'status:1*',
    'status:1?',
    'status:1_',
    'status:0x',
    'status:1ü',
    'status:1#',
    'status:1e5.',
    'status:1e5x',
    'status:1.5.',
    'status:1..5',
    'status:-1x',
    'status:+1x',
    'status:.5x',
    'status:-.5x',
    'count:>-1x',
    'label:2024-01-01',
    'count:>1x',
    'count:>=2nd',
    'count:<1x',
    'count:<=1x',
    'count:=1x',
    'count:!=1x',
    '"count":1x',
    'status:1x label:x',
    'label:x status:1x',
    'status:1x AND label:x',
    'NOT status:1x',
    '-status:1x',
    '(status:1x)',
    'status:a 1x',
    '2nd',
    '1x',
    '-1x',
    'status:1\u00a0x',
    'status:1"b"',
    'status:ab"c"',
    'status:a""',
    'status:a//',
    'status:a"b c"',
    'status:a/b/i',
    'status:x"1"',
    'status:a="b"',
    'status:*"a"',
    'status:-"a"',
    'status:-/a/',
    'status:-"a" label:x'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.success).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it.each([
    ['count:1', `"count" = 1`, [1, 3, 5]],
    ['count:01', `"count" = 1`, [1, 3, 5]],
    ['count:1.', `"count" = 1`, [1, 3, 5]],
    ['count:1.0', `"count" = 1`, [1, 3, 5]],
    ['count:+1', `"count" = 1`, [1, 3, 5]],
    ['count:1e0', `"count" = 1`, [1, 3, 5]],
    ['count:1.e5', `"count" = 100000`, []],
    ['count:-1', `"count" = -1`, []],
    ['count:.5', `"count" = 0.5`, []],
    ['count:-.5', `"count" = -0.5`, []],
    ['count:1.5e2', `"count" = 150`, []],
    ['count:>1', `"count" > 1`, [2, 4]],
    ['count:[1 TO 2]', `("count" >= 1) AND ("count" <= 2)`, [1, 2, 3, 5]],
    ['label:"1x"', `"label" = '1x'`, [1]],
    ["label:'1x'", `"label" = '1x'`, [1]],
    ['status:"2nd"', `"status" = '2nd'`, [2]],
    ['label:"2024-01-01"', `"label" = '2024-01-01'`, [2]],
    ['status:"a\\"b\\""', `"status" = 'a"b"'`, [3]],
    ['status:\'a"b"\'', `"status" = 'a"b"'`, [3]],
    ['status:"a/b/"', `"status" = 'a/b/'`, [4]],
    ["status:'a/b/'", `"status" = 'a/b/'`, [4]],
    ['status:a', `"status" = 'a'`, [1, 5]],
    ['"status":"a"', `"status" = 'a'`, [1, 5]],
    ['status:x1', `"status" = 'x1'`, []],
    ['label:*x', `"label" LIKE '%x' ESCAPE '!'`, [1, 3]],
    ['status:in[2nd]', `"status" IN ('2nd')`, [2]],
    ['status:in["2nd"]', `"status" IN ('2nd')`, [2]],
    ['status:in[1x, 2nd]', `"status" IN ('1x', '2nd')`, [2]],
    ['status:in[a"b"]', `"status" IN ('a"b"')`, [3]],
    ['status:[1x TO 2nd]', `("status" >= '1x') AND ("status" <= '2nd')`, [2]],
    ['status:[a"b" TO c]', `("status" >= 'a"b"') AND ("status" <= 'c')`, [3, 4]]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });
});
