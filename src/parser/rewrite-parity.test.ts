/**
 * The search box reads the typed text as the parser's rewrites and Liqe
 * read it: a clause must name a field wherever it stands, a quote or regex
 * must begin where a value may begin, text glued to a bracket closer is
 * joined to what the rewrite wrote there, a list or two-sided range after
 * a clause-leading minus becomes `-(`, parentheses inside a bracket body
 * are values, `field:!=` is `NOT field:` with any ordered operator kept,
 * and a regex spans what Liqe reads in the rewritten text.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { findTrailingLogicalOperator, parseQueryInput } from './tokenizer';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a', label: 'x', count: 1 },
  { id: 2, status: ')', label: '(', count: 5 },
  { id: 3, status: 'ab', label: 'or', count: 15 },
  { id: 4, status: 'b', label: '?', count: 3 }
];

describe('search box parity with the parser rewrites', () => {
  const parser = new QueryParser();

  it.each([
    // the twelve recorded neighbours
    'status:[a]"b"',
    'status:[a]/b/',
    'NOT"a"',
    'NOT/a/',
    'status:a AND"b"',
    'status:a OR"b"',
    'status:a AND/b/',
    'a"b"',
    'a/b/',
    'ab"c" label:x',
    '/a/ status:in[a]',
    '/a/ status:!=b',
    // a bare word, phrase, numeral or symbol beside a clause Liqe cannot
    // read before the rewrites
    'x status:!=a',
    'status:!=a AND x',
    'label:[a] "open"',
    'status:a +1',
    '"a" .5',
    'open status:in[a]',
    '_f:!=not or true',
    '(a=b)',
    '=',
    '-AND',
    '// "" \\',
    '1e5',
    // text glued to a bracket or range closer
    'status:[1]x',
    'status:[a, b]c',
    'status:[1 TO 5]x',
    'status:[1]"q"',
    'status:[a TO *]b',
    'status:["a"]b',
    'status:[a, b]and x:1',
    'status:[a, b]AND',
    'status:[a, b]AND ',
    'count:[1 TO *]x',
    'label:[1, 2]-',
    'count:[/a,b/]-',
    'status:[/a/]b',
    'count:>[1 TO 5]x',
    'count:>[1 TO 5]AND x:1',
    // a minus before a list or two-sided range
    '-x:[a TO b]',
    '-label:[a, b]',
    '(-x:[a TO b])',
    '-count:{1 TO 5}',
    '-"sta tus":[a, b]',
    // an exponent past the spelling limit
    'count:1e401',
    'count:1e999',
    'count:1e-401',
    'count:[1e401]',
    // parentheses: a value inside a bracket body is not a group, and a
    // glued AND or OR takes one group on its left and one operand on its right
    'status:[)] (',
    '(r:[)()] (y:1)',
    '((-y:[)])',
    '(a:1)AND(b:2)AND(c:3)',
    'x:1 (a:1)AND(b:2)',
    's:a AND(y:D l:a)',
    's:a OR(y:D AND l:a)',
    // a quoted field with an operator and no value
    '"status":',
    '"sta tus":<=',
    '\'q\':!= "a"',
    '"":',
    '"": ',
    // two regexes Liqe reads two ways in the rewritten text
    'x:!=/a/ AND y:/b/',
    'status:in[a] x:/a/ y:/b/',
    'l:[//] f:!=//',
    'count:<=/[/]/ AND T:>=/a b/ OR NOT a.b:{a, b}',
    'status:</a/gi count:/a\\/b/\nstatus:[1 TO *]',
    // a membership placeholder swallowed by a regex, and a stacked NOT
    'f:[//]x:in[]/',
    'NOT x:!=>5'
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
    ['status:[)]', `"status" = ')'`, [2]],
    ['label:in[(]', `"label" IN ('(')`, [2]],
    ['count:!=>5', `NOT ("count" > 5)`, [1, 2, 4]],
    ['count:!=>[1 TO 5]', `NOT (("count" >= 1) AND ("count" <= 5))`, [3]],
    [
      'count:!==5',
      `NOT (("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = 5))`,
      [1, 3, 4]
    ],
    ['"label":>=or', `"label" >= 'or'`, [1, 3]],
    ["'label':?", `"label" LIKE '_' ESCAPE '!'`, [1, 2, 4]],
    ['"label":!=\ufeffa', `NOT ("label" = '\ufeffa')`, [1, 2, 3, 4]],
    ['status:[a]b', `"status" = 'ab'`, [3]],
    ['count:[1 TO *]5', `"count" >= 15`, [3]],
    ['label:[a]AND status:a', `("label" = 'aAND') AND ("status" = 'a')`, []],
    [
      'label:[x, or]AND status:a',
      `(("label" = 'x') OR ("label" = 'or')) AND ("status" = 'a')`,
      [1]
    ],
    ['-count:[1 TO *]', `NOT ("count" >= 1)`, []],
    ['-status:[a]', `NOT ("status" = 'a')`, [2, 3, 4]],
    ['-status:in[a, b]', `NOT ("status" IN ('a', 'b'))`, [2, 3]],
    [
      'NOT status:[a TO b]',
      `NOT (("status" >= 'a') AND ("status" <= 'b'))`,
      [2]
    ],
    [
      '(status:a)AND(count:1)',
      `("status" = 'a') AND (("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = 1))`,
      [1]
    ],
    [
      'status:a AND(count:1)',
      `("status" = 'a') AND (("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = 1))`,
      [1]
    ],
    [
      '(status:a count:1)AND label:x',
      `(("status" = 'a') AND (("count" IS NULL AND NULL) OR (typeof("count") IN ('integer', 'real') AND "count" = 1))) AND ("label" = 'x')`,
      [1]
    ]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
    expect(parser.parseWithContext(query).success).toBe(true);
  });

  it.each([
    ['status:!=/a/b/', '/a/b/'],
    ['status:!=///', '///'],
    ['x:[//]/', '///'],
    ['status:[/a/]i', '/a/i'],
    ['(l://t: /)', '//t: /']
  ])('keeps %p complete as the unexecuted regex %p', (query, pattern) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    const comparison =
      expression.type === 'logical' ? expression.left : expression;
    expect(comparison).toMatchObject({ operator: 'REGEX', value: pattern });
    expect(() =>
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toThrow('Unsupported operator: REGEX');
  });

  it('reads an operator word glued to a quoted field as its value', () => {
    expect(findTrailingLogicalOperator('"sta tus":>=or')).toBeNull();
  });

  it('reads a regex literal from the whole text, not the rest of it', () => {
    const [term] = parseQueryInput('(l://t: /)').terms;
    expect(term).toMatchObject({ key: 'l', operator: ':', value: '//t: /' });
  });
});
