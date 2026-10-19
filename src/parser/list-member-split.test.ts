/**
 * Splitting a bracket list into members.
 *
 * The comma split used by the bracket rewrite and the membership rewrite
 * skipped quoted text but not regex literals, so `status:[/a,b/]` was cut
 * into `/a` and `b/`, written back as `(status:/a OR status:b/)`, and read
 * by Liqe as the regex `/a OR status:b/`, a value nobody typed. The split
 * now reads every literal with the scanner's `readLiteralAt`, the same walk
 * `hasCodeComma` already used, so a regex whose body holds a comma stays one
 * member. `REGEX` is still refused by every executor; nothing compiles a
 * pattern.
 *
 * These are the parser-level cases of docs/bugs/regex-list-member.md; the
 * search-box side of that report (`src/parser/regex-list-member.test.ts`)
 * lands with the input parser, as does the Liqe-span reading of two regex
 * literals in one body.
 */

import { QueryParser } from './parser';
import { splitListMembers } from './query-scanner';
import { IComparisonExpression } from './types';

function comparison(
  operator: IComparisonExpression['operator'],
  value: IComparisonExpression['value'],
  field = 'status'
): IComparisonExpression {
  return { type: 'comparison', field, operator, value };
}

describe('bracket list members', () => {
  const parser = new QueryParser();

  it('keeps a regex literal with a comma one bracket member', () => {
    expect(parser.parse('status:[/a,b/]')).toEqual(
      comparison('REGEX', '/a,b/')
    );
    expect(parser.parse('status:[ /a,b/ ]')).toEqual(
      comparison('REGEX', '/a,b/')
    );
    expect(parser.parse('status:[/a,/]')).toEqual(comparison('REGEX', '/a,/'));
    expect(parser.parse('status:[/,/]')).toEqual(comparison('REGEX', '/,/'));
    expect(parser.parse('status:[/[a,b]/]')).toEqual(
      comparison('REGEX', '/[a,b]/')
    );
    expect(parser.parse('status:[/a\\/b,c/]')).toEqual(
      comparison('REGEX', '/a\\/b,c/')
    );
  });

  it('keeps a regex literal with a comma one member beside other members', () => {
    expect(parser.parse('status:[x, /a,b/]')).toEqual({
      type: 'logical',
      operator: 'OR',
      left: comparison('==', 'x'),
      right: comparison('REGEX', '/a,b/')
    });
    expect(parser.parse('status:[/a,b/, x]')).toEqual({
      type: 'logical',
      operator: 'OR',
      left: comparison('REGEX', '/a,b/'),
      right: comparison('==', 'x')
    });
    expect(parser.parse('status:["x", /a,b/]')).toEqual({
      type: 'logical',
      operator: 'OR',
      left: comparison('==', 'x'),
      right: comparison('REGEX', '/a,b/')
    });
  });

  it('keeps a regex literal with a comma one membership member', () => {
    expect(parser.parse('status:in [/a,b/]')).toEqual(
      comparison('IN', ['/a,b/'])
    );
    expect(parser.parse('status:not in [/a,b/, x]')).toEqual(
      comparison('NOT IN', ['/a,b/', 'x'])
    );
  });

  it('keeps the lists that already agreed', () => {
    expect(parser.parse('status:[/a/]')).toEqual(comparison('REGEX', '/a/'));
    expect(parser.parse('status:[/a/, x]')).toEqual({
      type: 'logical',
      operator: 'OR',
      left: comparison('REGEX', '/a/'),
      right: comparison('==', 'x')
    });
    expect(parser.parse('status:in [/a/]')).toEqual(comparison('IN', ['/a/']));
    expect(parser.parse('status:[x, y]')).toEqual({
      type: 'logical',
      operator: 'OR',
      left: comparison('==', 'x'),
      right: comparison('==', 'y')
    });
    expect(parser.parse('status:["a,b"]')).toEqual(comparison('==', 'a,b'));
    expect(parser.parse('status:[x, "a,b"]')).toEqual({
      type: 'logical',
      operator: 'OR',
      left: comparison('==', 'x'),
      right: comparison('==', 'a,b')
    });
    expect(parser.parse('status:in["a,b", c]')).toEqual(
      comparison('IN', ['a,b', 'c'])
    );
    expect(parser.parse('status:[/a,b/ TO c]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('>=', '/a,b/'),
      right: comparison('<=', 'c')
    });
  });

  describe('splitListMembers', () => {
    it('splits on commas outside quotes and regex literals', () => {
      expect(splitListMembers('a, "b,c", /d,e/, f')).toEqual([
        'a',
        '"b,c"',
        '/d,e/',
        'f'
      ]);
      expect(splitListMembers("'x,y', z")).toEqual(["'x,y'", 'z']);
    });

    it('keeps a backslash escape inside quotes and runs an unclosed literal to the end', () => {
      expect(splitListMembers('"a\\",b", c')).toEqual(['"a\\",b"', 'c']);
      expect(splitListMembers('"unclosed, x')).toEqual(['"unclosed, x']);
      expect(splitListMembers('/unclosed, x')).toEqual(['/unclosed, x']);
    });

    it('trims members and drops empty ones', () => {
      expect(splitListMembers(' , a ,, b ,')).toEqual(['a', 'b']);
      expect(splitListMembers('')).toEqual([]);
      expect(splitListMembers('   ')).toEqual([]);
    });
  });
});
