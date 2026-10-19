/**
 * Raw line feed inside quotes.
 *
 * Liqe's string characters exclude a line feed, so a quoted value, member,
 * bound or field name that holds one is a syntax error, and a quoted
 * membership member fails the membership decode. The two-character escape
 * `\n` and a raw carriage return stay in the value on every engine.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a\nb', label: 'x' },
  { id: 2, status: 'a\r\nb', label: 'x' },
  { id: 3, status: 'ab', label: 'x' },
  { id: 4, status: 'a\rb', label: 'x' },
  { id: 5, status: 'open', label: 'x' },
  { id: 6, status: 'open', label: 'y' }
];

describe('newline in quotes', () => {
  const parser = new QueryParser();

  it.each([
    'status:"a\nb"',
    "status:'a\nb'",
    'status:"a\r\nb"',
    'status:["a\nb"]',
    "status:'a\r\nb'",
    'status:in["a\nb"]',
    "status:in['a\nb']",
    'status:not in["a\nb"]',
    "status:['a\nb']",
    'status:{"a\nb", c}',
    'status:["a\nb", c]',
    'status:[c, "a\nb"]',
    'status:["a\nb" TO c]',
    'status:[a TO "a\nb"]',
    'status:"a\nb" label:x',
    'label:x status:"a\nb"',
    'status:"a\nb" AND label:x',
    'status:"a\nb" OR label:x',
    'status:"a\nb"\nlabel:x',
    'NOT status:"a\nb"',
    '-status:"a\nb"',
    '(status:"a\nb")',
    'status:>"a\nb"',
    'status:>="a\nb"',
    'status:<"a\nb"',
    'status:!="a\nb"',
    '"sta\ntus":open',
    "'sta\ntus':open",
    '"a\nb"',
    '"a\nb" label:x',
    'status:"\nab"',
    'status:"ab\n"',
    'status:"\n"',
    'status:"a\n\nb"',
    'status:"a \n b"',
    'status:"a\\"\nb"',
    'status:"a\\\\\nb"',
    'status:"a\\n\nb"',
    'status:"a\nb*"',
    'status:{"a\nb"}',
    'status:"a\nb"c',
    'status:"a\\\nb"'
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
    ['status:"a\\nb"', `"status" = 'a\nb'`, [1]],
    ["status:'a\\nb'", `"status" = 'a\nb'`, [1]],
    ['status:["a\\nb"]', `"status" = 'a\nb'`, [1]],
    ['status:in["a\\nb"]', `"status" IN ('a\nb')`, [1]],
    ['status:in[a\nb]', `"status" IN ('a\nb')`, [1]],
    ['status:"a\\r\\nb"', `"status" = 'a\r\nb'`, [2]],
    ['status:"ab"', `"status" = 'ab'`, [3]],
    ['status:ab', `"status" = 'ab'`, [3]],
    ['status:"a\rb"', `"status" = 'a\rb'`, [4]],
    ["status:'a\rb'", `"status" = 'a\rb'`, [4]],
    ['status:["a\rb"]', `"status" = 'a\rb'`, [4]],
    ['status:in["a\rb"]', `"status" IN ('a\rb')`, [4]],
    ['status:"a\rb" label:x', `("status" = 'a\rb') AND ("label" = 'x')`, [4]],
    ['status:open\nlabel:x', `("status" = 'open') AND ("label" = 'x')`, [5]],
    ['status:"open"\nlabel:x', `("status" = 'open') AND ("label" = 'x')`, [5]],
    ['status:"a\\nb"\nlabel:x', `("status" = 'a\nb') AND ("label" = 'x')`, [1]],
    ['status:["a",\n"b"]', `("status" = 'a') OR ("status" = 'b')`, []],
    ['status:in["a",\n"b"]', `"status" IN ('a', 'b')`, []]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('keeps a line feed inside a regex body', () => {
    expect(isInputComplete('status:/a\nb/')).toBe(true);
    expect(parser.parse('status:/a\nb/')).toMatchObject({ operator: 'REGEX' });
  });
});
