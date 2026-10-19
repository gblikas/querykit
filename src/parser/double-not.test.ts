/**
 * Double NOT.
 *
 * Liqe's unary `NOT` takes a tag or a parenthesized group, so a second
 * `NOT` right after the first is a syntax error. Neither word is dropped,
 * and `NOT (NOT status:open)` keeps both negations.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open' },
  { id: 2, status: 'closed' }
];

describe('double NOT', () => {
  const parser = new QueryParser();

  it.each(['NOT NOT status:open', 'NOT NOT NOT status:open'])(
    'treats %p as incomplete and rejected',
    query => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => parser.parse(query)).toThrow(
        'Syntax error at line 1 column 8'
      );
      expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
      const context = parser.parseWithContext(query);
      expect(context.structure.isComplete).toBe(false);
      expect(context.success).toBe(false);
      expect(context.ast).toBeUndefined();
      expect(context.recovery?.autofix).toBeUndefined();
    }
  );

  it.each([
    ['NOT (NOT status:open)', `NOT (NOT ("status" = 'open'))`, [1]],
    ['status:open', `"status" = 'open'`, [1]],
    ['NOT status:open', `NOT ("status" = 'open')`, [2]]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it('keeps NOT NOT inside quotes and inside a regex', () => {
    expect(isInputComplete('note:"NOT NOT"')).toBe(true);
    expect(parser.parse('note:"NOT NOT"')).toMatchObject({ value: 'NOT NOT' });
    const regex = 'a:/x/ AND NOT NOT b:in[1] OR c:/y/';
    expect(isInputComplete(regex)).toBe(true);
    expect(parser.parse(regex)).toMatchObject({
      operator: 'REGEX',
      value: '/x/ AND NOT NOT b:in[1] OR c:/y/'
    });
  });
});
