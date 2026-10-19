/**
 * Glued list members.
 *
 * A list member or range bound that begins with a quote or a regex is copied
 * as written when nothing forces the rewrite to quote it, so a tail glued to
 * the literal reaches Liqe and is rejected; a quoted membership member with
 * a second quote fails the membership decode. A member that holds
 * whitespace, a parenthesis or a colon is quoted whole and stays a value.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a' },
  { id: 2, status: 'ab' },
  { id: 3, status: 'a b' },
  { id: 4, status: 'x' },
  { id: 5, status: 'c' }
];

describe('glued list member', () => {
  const parser = new QueryParser();

  it.each([
    'status:["a"b]',
    "status:['a'b]",
    'status:[x, "a"b]',
    'status:["a"b, x]',
    'status:["a"b,x]',
    'status:[ "a"b ]',
    'status:["a"b, ]',
    'status:{x, "a"b}',
    'status:{"a"b, x}',
    'status:["a"b"c"]',
    "status:['a'b'c']",
    'status:["a"\'b\']',
    'status:["a":"b"]',
    'status:["a"-"b"]',
    'status:["a"/b/]',
    'status:["a"1]',
    'status:["a"*]',
    'status:["a".b]',
    'status:["a"_b]',
    'status:[""b]',
    'status:["a\\"b"c]',
    '"status":["a"b]',
    'status:["a"b] label:x',
    'label:x status:["a"b]',
    'status:["a"b] AND label:x',
    'status:[x] AND status:["a"b]',
    'NOT status:["a"b]',
    '-status:["a"b]',
    '(status:["a"b])',
    'status:[/a/b]',
    'status:[/a/ib]',
    'status:[/a/b, x]',
    'status:[x, /a/b]',
    'status:{x, /a/b}',
    'status:[/a/"b"]',
    'status:[/a/1]',
    'status:[/a/-b]',
    'status:[/a/.b]',
    'status:[/a/*]',
    'status:[/[a/]/b]',
    'status:[/a\\/b/c]',
    'status:[/a/b] label:x',
    'NOT status:[/a/b]',
    'status:["a"b"c" TO d]',
    'status:[a TO "b"c"d"]',
    'status:["a"b TO "c"d"e"]',
    'status:{"a"b"c" TO d}',
    'status:[* TO "b"c"d"]',
    'status:["a"b"c" TO *]',
    "status:['a'b'c' TO d]",
    'status:["a":"b" TO d]',
    'status:in ["a"b"c"]',
    "status:in ['a'b'c']",
    'status:in ["a":"b"]',
    'status:in ["a" "b"]',
    'status:in [x, "a"b"c"]',
    'status:in["a"b"c", x]',
    'status:not in ["a"b"c"]',
    'status:in ["a"b"c"] label:x'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    expect(parser.parseWithContext(query).recovery?.autofix).toBeUndefined();
  });

  it.each([
    [
      'status:["a"b TO c]',
      `("status" >= '"a"b') AND ("status" <= 'c')`,
      [1, 2, 3, 5]
    ],
    [
      'status:["a"b TO "c"]',
      `("status" >= '"a"b') AND ("status" <= 'c')`,
      [1, 2, 3, 5]
    ],
    [
      'status:[/a/b TO c]',
      `("status" >= '/a/b') AND ("status" <= 'c')`,
      [1, 2, 3, 5]
    ],
    ['status:[a TO "b"c]', `("status" >= 'a') AND ("status" <= '"b"c')`, []],
    ['status:["a b"]', `"status" = 'a b'`, [3]],
    ['status:["a b", c]', `("status" = 'a b') OR ("status" = 'c')`, [3, 5]],
    ['status:["a b"c]', `"status" = '"a b"c'`, []],
    ['status:["a" b]', `"status" = '"a" b'`, []],
    ['status:["a"(b)]', `"status" = '"a"(b)'`, []],
    ['status:["a":b]', `"status" = '"a":b'`, []],
    ['status:["a"b c]', `"status" = '"a"b c'`, []],
    ['status:["AND"]', `"status" = 'AND'`, []],
    ['status:["a"]', `"status" = 'a'`, [1]],
    ["status:['a']", `"status" = 'a'`, [1]],
    ['status:[a]', `"status" = 'a'`, [1]],
    ['status:["a", c]', `("status" = 'a') OR ("status" = 'c')`, [1, 5]],
    ['status:["a", "ab"]', `("status" = 'a') OR ("status" = 'ab')`, [1, 2]],
    ['status:["a\\"b"]', `"status" = 'a"b'`, []],
    ['status:[x]', `"status" = 'x'`, [4]],
    ['status:[ab]', `"status" = 'ab'`, [2]],
    ['status:[a TO b]', `("status" >= 'a') AND ("status" <= 'b')`, [1, 2, 3]],
    [
      'status:["a" TO "c"]',
      `("status" >= 'a') AND ("status" <= 'c')`,
      [1, 2, 3, 5]
    ],
    [
      'status:["a b" TO c]',
      `("status" >= 'a b') AND ("status" <= 'c')`,
      [2, 3, 5]
    ],
    ['status:in ["a"b]', `"status" IN ('"a"b')`, []],
    ['status:in [/a/b]', `"status" IN ('/a/b')`, []],
    ['status:in["a"b, c]', `"status" IN ('"a"b', 'c')`, [5]],
    ['status:in ["a\\"b"]', `"status" IN ('a"b')`, []],
    ['status:in ["a", "a b"]', `"status" IN ('a', 'a b')`, [1, 3]],
    ['status:not in ["a"b]', `"status" NOT IN ('"a"b')`, [1, 2, 3, 4, 5]]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each([
    ['status:[/a/]', '/a/'],
    ['status:[/a/i]', '/a/i'],
    ['status:[/a/gi]', '/a/gi']
  ])('keeps %p one REGEX comparison on %p', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'status',
      operator: 'REGEX',
      value
    });
    expect(() => filterInMemory(query, rows)).toThrow(
      'Unsupported operator: REGEX'
    );
  });

  it('keeps a regex beside a word as REGEX OR equality', () => {
    expect(isInputComplete('status:[/a/, x]')).toBe(true);
    expect(parser.parse('status:[/a/, x]')).toMatchObject({
      type: 'logical',
      operator: 'OR',
      left: { operator: 'REGEX', value: '/a/' },
      right: { operator: '==', value: 'x' }
    });
  });
});
