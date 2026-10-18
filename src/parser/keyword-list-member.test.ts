/**
 * Keyword and digit-led list members.
 *
 * A bracket list is rewritten member by member; an unquoted member with no
 * whitespace, parenthesis or colon is written back as it stands, so
 * `[AND]` reaches Liqe as the operator word and `[1x]` as a broken numeral.
 * Operator words are uppercased before the rewrite, so `[ and ]` is `AND`
 * while `[and]` stays the value `and`. Quoted members, membership lists and
 * ranges keep their values.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { hasRejectedListMember } from './query-scanner';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'AND' },
  { id: 2, status: 'and' },
  { id: 3, status: 'x' },
  { id: 4, status: '1x' },
  { id: 5, status: 'open' }
];

describe('keyword list member', () => {
  const parser = new QueryParser();

  it.each([
    'status:[AND]',
    'status:[OR]',
    'status:[NOT]',
    'status:[ AND ]',
    'status:[AND, ]',
    '"status":[AND]',
    'NOT status:[AND]',
    '-status:[AND]',
    'label:x AND status:[AND]',
    'status:[x] AND status:[AND]',
    'status:[x, AND]',
    'status:[x,AND]',
    'status:[x, AND, open]',
    'status:["AND", AND]',
    'status:{x, AND}',
    'status:[x, AND] label:x',
    'status:[AND, x]',
    'status:[AND, and]',
    'status:[AND, /a/]',
    'status:[AND, 1x]',
    'status:{AND, and}',
    '(status:[AND])',
    'status:[AND] AND label:x',
    'status:[ and ]',
    'status:[ or ]',
    'status:[ not ]',
    'status:[x, and ]',
    'status:[ and , x]',
    'status:[x, And ]',
    'status:[1x]',
    'status:[x, 1x]',
    'status:[1x, x]',
    'status:{x, 1x}',
    'status:[1x] label:x'
  ])('treats %p as incomplete and rejected', query => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    expect(parser.parseWithContext(query).recovery?.autofix).toBeUndefined();
  });

  it('reports a rejected member through the predicate it is given', () => {
    const isKeyword = (member: string): boolean => member === 'AND';
    expect(hasRejectedListMember('status:[AND]', isKeyword)).toBe(true);
    expect(hasRejectedListMember('status:[x, AND]', isKeyword)).toBe(true);
    expect(hasRejectedListMember('status:["AND"]', isKeyword)).toBe(false);
    expect(hasRejectedListMember('status:[AND y]', isKeyword)).toBe(false);
    expect(hasRejectedListMember('status:in[AND]', isKeyword)).toBe(false);
    expect(hasRejectedListMember('status:[AND TO x]', isKeyword)).toBe(false);
  });

  it.each([
    ['status:["AND"]', `"status" = 'AND'`, [1]],
    ["status:['AND']", `"status" = 'AND'`, [1]],
    ['status:[ "AND" ]', `"status" = 'AND'`, [1]],
    ['status:["1x"]', `"status" = '1x'`, [4]],
    ['status:[x, "AND"]', `("status" = 'x') OR ("status" = 'AND')`, [1, 3]],
    ['status:[and]', `"status" = 'and'`, [2]],
    ['status:[and ]', `"status" = 'and'`, [2]],
    ['status:[ and]', `"status" = 'and'`, [2]],
    ['status:[x,and ]', `("status" = 'x') OR ("status" = 'and')`, [2, 3]],
    [
      'status:[x, and, open]',
      `(("status" = 'x') OR ("status" = 'and')) OR ("status" = 'open')`,
      [2, 3, 5]
    ],
    ['status:[And]', `"status" = 'And'`, []],
    ['status:[ANDx]', `"status" = 'ANDx'`, []],
    ['status:[AND y]', `"status" = 'AND y'`, []],
    ['status:[x]', `"status" = 'x'`, [3]],
    ['status:[open]', `"status" = 'open'`, [5]],
    ['status:[x, open]', `("status" = 'x') OR ("status" = 'open')`, [3, 5]],
    ['status:[a TO b]', `("status" >= 'a') AND ("status" <= 'b')`, [2]],
    ['status:[AND TO TO]', `("status" >= 'AND') AND ("status" <= 'TO')`, [1]],
    ['status:in [a, b]', `"status" IN ('a', 'b')`, []],
    ['status:in [AND]', `"status" IN ('AND')`, [1]],
    ['status:in[AND]', `"status" IN ('AND')`, [1]],
    ['status:in [1x]', `"status" IN ('1x')`, [4]],
    ['status:in [x, AND]', `"status" IN ('x', 'AND')`, [1, 3]]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });
});
