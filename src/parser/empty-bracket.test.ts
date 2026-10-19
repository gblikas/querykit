/**
 * Empty and rejected bracket bodies.
 *
 * The parser's bracket rewrite leaves some bodies in place for Liqe, which
 * rejects them: an empty body, a one-member brace, a range with an empty
 * bound or both bounds `*`, an unclosed opener, and a membership list with
 * the wrong closer. `status:[a TO]` is a one-member list and `status:in []`
 * an empty membership list; both stay accepted.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'a' },
  { id: 2, status: 'b' },
  { id: 3, status: 'abc' }
];

describe('empty bracket', () => {
  const parser = new QueryParser();

  it.each([
    'status:[ ]',
    'status:[]',
    'status:{}',
    'status:{abc}',
    'status:{ }',
    'status:[  ]',
    'status:[\t]',
    'status:[\n]',
    '"status":[]',
    '-status:[]',
    'NOT status:[]',
    '(status:[])',
    'status:[] AND label:x',
    'label:x status:[]',
    'status:{ abc }',
    'status:{"abc"}',
    'status:{1}',
    'status:{a TO}',
    'status:{a]',
    'status:{a TO b TO c}',
    'status:[a TO ]',
    'status:[ TO b]',
    'status:[ TO ]',
    'status:[* TO *]',
    'status:{* TO *}',
    'status:[',
    'status:{',
    'status:[a',
    'status:{a',
    'status:[a TO',
    'status:in[a}',
    'status:in [',
    'status:in[a'
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
    ['status:[a TO b]', `("status" >= 'a') AND ("status" <= 'b')`, [1, 2, 3]],
    ['status:{a TO b}', `("status" > 'a') AND ("status" < 'b')`, [3]],
    ['status:in [a, b]', `"status" IN ('a', 'b')`, [1, 2]],
    ['status:in[a, b]', `"status" IN ('a', 'b')`, [1, 2]],
    ['status:[a TO]', `"status" = 'a TO'`, []],
    ['status:in []', 'FALSE', []],
    ['status:in[]', 'FALSE', []],
    ['status:not in []', 'TRUE', [1, 2, 3]],
    ['status:[abc]', `"status" = 'abc'`, [3]],
    ['status:{a, b}', `("status" = 'a') OR ("status" = 'b')`, [1, 2]],
    ['status:[a TO *]', `"status" >= 'a'`, [1, 2, 3]],
    ['status:[* TO b]', `"status" <= 'b'`, [1, 2, 3]],
    ['status:"[]"', `"status" = '[]'`, []],
    ['status:"{abc}"', `"status" = '{abc}'`, []]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });
});
