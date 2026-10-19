/**
 * The search box decides a bracket list with two regex members the way the
 * parser does: by Liqe's reading of the parser's actual rewritten text.
 *
 * The bracket rewrite writes `b:[,//,////]` as `(b:// OR b:////)`, which
 * Liqe reads two ways, so the parser throws `Ambiguous results.`; the
 * same-length stand-in the search box reads regex spans from replaces that
 * group by opaque text, so it never saw the two regexes and called the text
 * complete. Liqe's ambiguity and implicit-field checks now run on the
 * rewritten text itself, which also finds the lowercase `and` a regex hid
 * from the uppercasing (`r:!=///// and $:b`) and the bare `x` after a regex
 * member that runs on past its closer (`s:[/\//]/ x`), each the implicit
 * field the parser rejects. A `field:!=[a, b]` list reaches Liqe as
 * `NOT (field:a OR field:b)`, so its group never begins its operand and an
 * `AND` glued to its closer is rejected as Liqe rejects it. A list Liqe
 * reads one way stays as pinned.
 *
 * The rebuilt probe also reached a regex whose body holds `\\`: Liqe's
 * regex body is any character but a backslash, or a backslash and one such
 * character, so `l:/\\/` is a syntax error, while the scan that closes a
 * regex where Liqe cannot read the text pairs `\\` as an escape and called
 * it complete. A regex that reaches Liqe as one and holds `\\` is now
 * incomplete; one Liqe never reads as a regex, a quoted bound or member,
 * stays complete.
 *
 * One recorded search-box-stricter leftover fell out of the same change: the
 * stand-in blanks the brackets of a one-member list, and Liqe reads
 * `b: -1 ` two ways where the parser's `b:-1` is one reading, so `b:[-1]`
 * was incomplete while `parse` accepted it. Decided on the rewritten text,
 * it is complete.
 */

import { filterInMemory } from '../adapters/memory';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a', l: 'a', x: 1 },
  { id: 2, status: 'x', l: 'c', x: 1 }
];

describe('a bracket list with two regex members', () => {
  const parser = new QueryParser();

  it.each([
    'b:[,//,////]',
    's:[,//,//]',
    'x:!={,//,////]',
    'status:[/a/, /b/, x]',
    'status:[x, /a/, /b/]',
    'status:[/a/,/b/, x]'
  ])('marks %p incomplete, a rewrite Liqe reads two ways', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow('Ambiguous results.');
    expectRejectedEverywhere(query);
  });

  it.each(['y:!=/// or s:\u2003', 'r:!=///// and $:b', 's:[/\\//]/ x'])(
    'marks %p incomplete, a rewrite Liqe reads with an implicit field',
    query => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(
        'Implicit field search is not supported'
      );
      expectRejectedEverywhere(query);
    }
  );

  it.each([
    'l:!={?,n]AND($://)',
    "'':!=['',e]AND $:not in[\"\"]",
    'x:!=[\'\',/\\//]AND "":o',
    'l:!=[a,b]AND(x:1)'
  ])('marks %p incomplete, a negated group glued to AND', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expectRejectedEverywhere(query);
  });

  it.each([
    ['status:[/a,b/]', 'REGEX', '/a,b/'],
    ['status:[/a/]', 'REGEX', '/a/'],
    ['status:/a/', 'REGEX', '/a/']
  ])('keeps %p complete as the unexecuted regex', (query, operator, value) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'status',
      operator,
      value
    });
    expect(() => filterInMemory(query, rows)).toThrow(
      'Unsupported operator: REGEX'
    );
    expect(parser.parseWithContext(query).success).toBe(true);
  });

  it('keeps a plain member beside a regex member, member by member', () => {
    const query = 'status:[x, /a,b/]';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'logical',
      operator: 'OR',
      left: { type: 'comparison', field: 'status', operator: '==', value: 'x' },
      right: {
        type: 'comparison',
        field: 'status',
        operator: 'REGEX',
        value: '/a,b/'
      }
    });
    expect(parser.parseWithContext(query).success).toBe(true);
  });

  it('keeps a list with no member as the empty value', () => {
    const query = 'status:[,]';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: ''
    });
    expect(filterInMemory(query, rows)).toEqual([]);
  });

  it('keeps a list of plain members complete', () => {
    const query = 'status:[x, y]';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toEqual({
      type: 'logical',
      operator: 'OR',
      left: { type: 'comparison', field: 'status', operator: '==', value: 'x' },
      right: { type: 'comparison', field: 'status', operator: '==', value: 'y' }
    });
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([2]);
  });

  it.each([
    ['l:!=[a,b] AND(x:1)', [2]],
    ['(l:!=[a,b])AND(x:1)', [2]],
    ['l:[a,b]AND(x:1)', [1]]
  ])('keeps the group of %p complete where Liqe reads it', (query, ids) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ type: 'logical' });
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
    expect(parser.parseWithContext(query).success).toBe(true);
  });

  function expectRejectedEverywhere(query: string): void {
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
  }
});

describe('a regex whose body escapes a backslash', () => {
  const parser = new QueryParser();

  it.each([
    'l:/\\\\/',
    'l:/a\\\\b/',
    'l:/\\\\/i',
    'l:/\\/\\\\/',
    'x:/a/ y:/\\\\/',
    'status:[/\\\\/]',
    'status:[x, /\\\\/]',
    'status:[/\\\\/, x]'
  ])('marks %p incomplete, which Liqe rejects', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow('Syntax error');
    expect(parser.parseWithContext(query).success).toBe(false);
  });

  it.each([
    ['l:/\\//', { operator: 'REGEX', value: '/\\//' }],
    ['l:"\\\\"', { operator: '==', value: '\\' }],
    ['status:in[/\\\\/]', { operator: 'IN', value: ['/\\\\/'] }],
    ['status:[/\\\\/ x]', { operator: '==', value: '/\\\\/ x' }],
    ['status:[/\\\\/ TO b]', { operator: 'AND' }]
  ])('keeps %p complete as Liqe reads it', (query, shape) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject(shape);
    expect(parser.parseWithContext(query).success).toBe(true);
  });
});

describe('a negative numeral as the one list member', () => {
  const parser = new QueryParser();

  it.each([
    ['b:[-1]', { type: 'comparison', field: 'b', operator: '==', value: -1 }],
    ['b:[-1.5]', { field: 'b', operator: '==', value: -1.5 }],
    ['(l:[-1])', { field: 'l', operator: '==', value: -1 }],
    [
      't:!=[-1]',
      { operator: 'NOT', left: { field: 't', operator: '==', value: -1 } }
    ],
    ['r:!=[-1]\vb:5', { operator: 'AND', right: { field: 'b', value: 5 } }]
  ])('keeps %p complete, which the stand-in read two ways', (query, shape) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject(shape);
    expect(parser.parseWithContext(query).success).toBe(true);
  });
});
