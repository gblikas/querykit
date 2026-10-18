/**
 * A regex member the bracket rewrite writes back as typed must reach Liqe
 * as a regex literal of its own.
 *
 * The rewrite writes `T:[//]` as `T://`, dropping the brackets, so a regex
 * glued before the field (`x://T:[//]` becomes `x://T://`) would be read by
 * Liqe as the one regex `//T://` across the join, and a member of a group
 * the rewrite emits could swallow the ` OR ` and `)` written after it
 * (`r:[//,l]/)` becomes `(r:// OR r:l)/)`): queries no reading of the typed
 * text yields, which the search box marks incomplete. The parser now
 * requires a Liqe regex to begin at each such member, exactly the member
 * inside a group, and rejects the query otherwise; the search box marks a
 * member a regex before it swallows incomplete even when that regex runs on
 * past the closer (`x:[//]T:[//]/`). A regex that begins at the one member
 * of a list and runs past the closer into the typed text (`x:[//]/` is
 * `///`, `status:[/a/]i` is `/a/i`) stays as pinned, as the search box
 * reads it the same way.
 */

import { filterInMemory } from '../adapters/memory';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a', x: '//T://', T: 'b' },
  { id: 2, status: 'x', x: 'b', T: '//' }
];

const REGEX_MEMBER_MESSAGE =
  'A regex list member was not read as its own regex literal';

describe('regex member across a bracket join', () => {
  const parser = new QueryParser();

  it.each([
    // a regex glued before a bracket-valued field
    'x://T:[//]',
    'r://(x:[//])',
    't://f:[//]',
    '(y://]y:[//])',
    "''://x:[//]",
    'f://"" r:[//]',
    'x:[//]T:[//]',
    'x://T:[/a/]',
    'x:/a/T:[//]',
    // the regex runs on past the swallowed member's closer
    'x:[//]T:[//]/',
    'x:[//](T:[//])/',
    'x:[//](T:[a, //])/',
    // a member of an emitted group swallows the group's joiner and closer
    'r:[//,l]/)',
    'x:[//, a]/)',
    'r:[//,l] /)',
    'r:[//,l] x:/a/)',
    // the pinned control: a membership placeholder a regex swallows
    'f:[//]x:in[]/'
  ])('rejects %p and marks it incomplete', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it.each(['r://(x:[//]', 'T:!=[////](\'\':!=[//""]/'])(
    'rejects the unclosed group %p the probe recorded',
    query => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(REGEX_MEMBER_MESSAGE);
      expect(parser.parseWithContext(query).success).toBe(false);
    }
  );

  it.each([
    'x://T:[//]',
    't://f:[//]',
    '(y://]y:[//])',
    'x:[//]T:[//]',
    'x://T:[/a/]',
    'x:/a/T:[//]',
    'x:[//]T:[//]/',
    'T:!=[////](\'\':!=[//""]/',
    'r:[//,l]/)',
    'r:[//,l] x:/a/)'
  ])('names the regex member Liqe read across the join in %p', query => {
    expect(() => parser.parse(query)).toThrow(REGEX_MEMBER_MESSAGE);
  });

  it('still rejects a swallowed membership placeholder as before', () => {
    expect(() => parser.parse('f:[//]x:in[]/')).toThrow(
      'A membership list could not be placed in the parsed query'
    );
  });

  it.each([
    ['status:[/a,b/]', 'status', '/a,b/'],
    ['status:/a/', 'status', '/a/'],
    ['x:[//]/', 'x', '///'],
    ['status:[/a/]i', 'status', '/a/i'],
    ['x:[//]y:!=//', 'x', '//y:!=//'],
    ['x:[/[/]/]', 'x', '/[/]/'],
    ['status:[/a/b/c/]', 'status', '/a/b/c/']
  ])(
    'keeps %p complete as the unexecuted regex %p',
    (query, field, pattern) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      expect(expression).toEqual({
        type: 'comparison',
        field,
        operator: 'REGEX',
        value: pattern
      });
      expectEveryExecutorRefuses(query, expression);
      expect(parser.parseWithContext(query).success).toBe(true);
    }
  );

  it.each([
    ['status:[x, /a,b/]', '==', 'x', 'REGEX', '/a,b/'],
    ['status:[/a/, b]', 'REGEX', '/a/', '==', 'b'],
    ['r:[//,l]', 'REGEX', '//', '==', 'l']
  ])(
    'keeps %p as the equality or the unexecuted regex, member by member',
    (query, leftOperator, leftValue, rightOperator, rightValue) => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
      const field = query.split(':')[0];
      expect(expression).toEqual({
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'comparison',
          field,
          operator: leftOperator,
          value: leftValue
        },
        right: {
          type: 'comparison',
          field,
          operator: rightOperator,
          value: rightValue
        }
      });
      expectEveryExecutorRefuses(query, expression);
      expect(parser.parseWithContext(query).success).toBe(true);
    }
  );

  it('keeps a grouped regex member before another clause', () => {
    const query = 'r:[//,l] x:/a/';
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({
      type: 'logical',
      operator: 'AND',
      left: { type: 'logical', operator: 'OR' },
      right: { type: 'comparison', field: 'x', operator: 'REGEX', value: '/a/' }
    });
  });

  function expectEveryExecutorRefuses(
    query: string,
    expression: ReturnType<QueryParser['parse']>
  ): void {
    const message = 'Unsupported operator: REGEX';
    expect(() =>
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toThrow(message);
    expect(() =>
      new SqlTranslator({ useParameters: true }).translate(expression)
    ).toThrow(message);
    expect(() => new DrizzleTranslator().translate(expression)).toThrow(
      message
    );
    expect(() => filterInMemory(query, rows)).toThrow(message);
  }
});
