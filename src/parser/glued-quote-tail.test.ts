/**
 * Glued quote tail and digit-led names.
 *
 * A closed quote or regex must be followed by the end of the text, Liqe
 * whitespace or `)` (a quoted field name by `:`); anything glued to it is a
 * syntax error. A field name cannot start with a digit. Literals inside a
 * bracket body stay on the parser's rewrite.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a', label: 'x', state: 'open', '1status': 'open' },
  { id: 2, status: 'ab', label: 'x', state: 'closed' },
  { id: 3, status: 'a', label: 'y', state: 'open', '1status': 'open' }
];

describe('glued quote tail', () => {
  const parser = new QueryParser();

  it.each([
    'status:"a"b',
    "status:'a'b",
    'status:/a/b',
    '1:a',
    'status:"a"(label:x)',
    'status:"a"b label:x',
    'label:x status:"a"b',
    'status:"a"b AND label:x',
    'NOT status:"a"b',
    '-status:"a"b',
    '(status:"a"b)',
    'status:"a"AND label:x',
    'status:"a"OR label:x',
    'status:"a"NOT label:x',
    'status:"a"and label:x',
    'status:"a"\'b\'',
    'status:\'a\'"b"',
    'status:"a"/b/',
    'status:"a"b"c"',
    'status:"a"-b',
    'status:"a"1',
    'status:"a"*',
    'status:"a".b',
    'status:"a"_b',
    'status:"a"$b',
    'status:"a"ü',
    'status:"a"#b',
    'status:"a",b',
    'status:"a"=b',
    'status:"a">b',
    'status:"a"\\',
    'status:""b',
    'status:"a b"c',
    'status:"a\\"b"c',
    '"a"b',
    '"status"open',
    '"a"b label:x',
    'label:x "a"b',
    'status:/a/ib',
    'status:/a/-b',
    'status:/a/1',
    'status:/a/.b',
    'status:/a/*',
    'status:/a/x',
    'status:/a/"b"',
    'status:/a/AND label:x',
    'status:/a/b label:x',
    'NOT status:/a/b',
    '-status:/a/b',
    '/a/b',
    'status:/[a/]/b',
    'status:/a\\/b/c',
    '12:a',
    '1status:open',
    '1.5:a',
    '1_a:b',
    '0:a',
    '1e5:a',
    '1.:a',
    '1:"a"',
    '1:/a/',
    '1:>5',
    '1:a status:a',
    'status:a 1:x',
    'status:a AND 1:x'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.success).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  const AND_SQL = `("status" = 'a') AND ("label" = 'x')`;

  it.each([
    ['status:"a"', `"status" = 'a'`, [1, 3]],
    ["status:'a'", `"status" = 'a'`, [1, 3]],
    ['status:a', `"status" = 'a'`, [1, 3]],
    ['(status:"a")', `"status" = 'a'`, [1, 3]],
    ['status:"ab"', `"status" = 'ab'`, [2]],
    ['status:ab', `"status" = 'ab'`, [2]],
    ['label:x', `"label" = 'x'`, [1, 2]],
    ['status:"a" label:x', AND_SQL, [1]],
    ['status:"a"\tlabel:x', AND_SQL, [1]],
    ['status:"a"\nlabel:x', AND_SQL, [1]],
    ['(status:"a") label:x', AND_SQL, [1]],
    ['(status:"a")AND label:x', AND_SQL, [1]],
    ['-status:"a"', `NOT ("status" = 'a')`, [2]],
    ['"1status":open', `"1status" = 'open'`, [1, 3]],
    ["'1status':open", `"1status" = 'open'`, [1, 3]],
    ['status:1', `"status" = 1`, []],
    ['status:in["a", "b"]', `"status" IN ('a', 'b')`, [1, 3]],
    ['status:["a", "b"]', `("status" = 'a') OR ("status" = 'b')`, [1, 3]],
    ['status:in["a"b]', `"status" IN ('"a"b')`, []],
    [
      'status:["a"b TO c]',
      `("status" >= '"a"b') AND ("status" <= 'c')`,
      [1, 2, 3]
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
    'status:/a/',
    'status:/a/i',
    'status:/a/gi',
    'status:/a/ AND label:x'
  ])('keeps %p complete with its regex', query => {
    expect(isInputComplete(query)).toBe(true);
    expect(() => parser.parse(query)).not.toThrow();
  });
});
