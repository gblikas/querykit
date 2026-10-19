/**
 * Regex list member.
 *
 * The bracket rewrite splits members with the scanner's `splitListMembers`,
 * which jumps over string and regex literals, so a regex whose body holds a
 * comma stays one member and nothing writes `(status:/a OR status:b/)`. A
 * body Liqe reads as one regex, such as `/a/, /b/`, is one member even when
 * it holds a space. REGEX execution is unchanged: every engine refuses it.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { splitListMembers } from './query-scanner';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a' },
  { id: 2, status: 'b' },
  { id: 3, status: '/a,b/' }
];

describe('regex list member', () => {
  const parser = new QueryParser();

  it.each([
    ['status:[/a,b/]', '/a,b/'],
    ['status:[ /a,b/ ]', '/a,b/'],
    ['status:[/a,/]', '/a,/'],
    ['status:[/,/]', '/,/'],
    ['status:[/[,]/]', '/[,]/'],
    ['status:[/a\\/,b/]', '/a\\/,b/'],
    ['status:[/a/]', '/a/'],
    ['status:[/a/,/b/]', '/a/,/b/'],
    ['status:/a/, /b/', '/a/, /b/']
  ])('keeps %p one refused REGEX comparison on %p', (query, value) => {
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

  it.each([
    ['status:[x, /a,b/]', 'x', '/a,b/'],
    ['status:[/a,b/, x]', '/a,b/', 'x'],
    ['status:[/a/, x]', '/a/', 'x']
  ])('keeps %p a two-member OR', (query, first, second) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ type: 'logical', operator: 'OR' });
    const values = [expression, expression].map((node, index) =>
      node.type === 'logical' ? (index === 0 ? node.left : node.right) : node
    );
    expect(values.map(node => (node as { value: unknown }).value)).toEqual([
      first,
      second
    ]);
  });

  it.each([
    ['status:in [/a,b/]', `"status" IN ('/a,b/')`, [3]],
    ['status:in [/a/, /b/]', `"status" IN ('/a/, /b/')`, []],
    ['status:[/a/, /b/]', `"status" = '/a/, /b/'`, []],
    ['status:[/a,b/ x]', `"status" = '/a,b/ x'`, []],
    ['status:[/a,b/(x)]', `"status" = '/a,b/(x)'`, []],
    ['status:[/a,b/:x]', `"status" = '/a,b/:x'`, []],
    ['status:[x, y]', `("status" = 'x') OR ("status" = 'y')`, []],
    ['status:["a,b"]', `"status" = 'a,b'`, []],
    [
      'status:[/a,b/ TO c]',
      `("status" >= '/a,b/') AND ("status" <= 'c')`,
      [1, 2, 3]
    ],
    ['status:in [/a/]', `"status" IN ('/a/')`, []]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each([
    'status:[a/b, c]',
    'status:[a, b/]',
    'status:[/a,b]',
    'status:[a/b,c/, d]',
    'status:[a/b/, c]',
    'status:{/a,b/}'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it('splits members at commas outside literals only', () => {
    expect(splitListMembers('/a,b/')).toEqual(['/a,b/']);
    expect(splitListMembers('x, /a,b/')).toEqual(['x', '/a,b/']);
    expect(splitListMembers('/a/, /b/')).toEqual(['/a/, /b/']);
    expect(splitListMembers('/a/,/b/')).toEqual(['/a/,/b/']);
    expect(splitListMembers('"a,b", c')).toEqual(['"a,b"', 'c']);
    expect(splitListMembers('a, , b')).toEqual(['a', 'b']);
  });
});
