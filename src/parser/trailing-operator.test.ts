/**
 * Trailing operator.
 *
 * `&&` and `||` are not Liqe operators and not value characters, so a
 * trailing pair is a syntax error. The search box only looked for a
 * trailing word; it is now incomplete for the symbols too, and recovery
 * still offers no autofix, so the query is not rewritten as `status:open`.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open' },
  { id: 2, status: 'done' }
];

describe('trailing operator', () => {
  const parser = new QueryParser();

  it.each([
    ['status:open AND', 'Found no parsings.'],
    ['status:open OR', 'Found no parsings.'],
    ['status:open &&', 'Syntax error at line 1 column 13'],
    ['status:open ||', 'Syntax error at line 1 column 13'],
    ['status:open && ', 'Syntax error at line 1 column 13'],
    ['status:open ||\t', 'Syntax error at line 1 column 13'],
    ['status:open&&', 'Syntax error at line 1 column 12'],
    ['status:open||', 'Syntax error at line 1 column 12']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.success).toBe(false);
    if (query.includes('&') || query.includes('|')) {
      expect(context.recovery?.autofix).toBeUndefined();
    }
  });

  it('keeps status:open complete and matching the open row', () => {
    expect(isInputComplete('status:open')).toBe(true);
    const expression = parser.parse('status:open');
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"status" = 'open'`);
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([1]);
  });

  it.each([
    ['status:"open &&"', 'open &&'],
    ["status:'open ||'", 'open ||']
  ])('keeps %p as the quoted value %p', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ operator: '==', value });
    expect(
      new SqlTranslator({ useParameters: true }).translate(expression)
    ).toEqual({ sql: '"status" = ?', params: [value] });
    expect(filterInMemory(query, rows)).toEqual([]);
  });

  it.each(['name:/&&/', 'name:/||/'])('keeps %p a regex', query => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: 'REGEX' });
    expect(() => filterInMemory(query, rows)).toThrow(
      'Unsupported operator: REGEX'
    );
  });
});
