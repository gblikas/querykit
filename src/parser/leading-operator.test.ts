/**
 * Leading operator.
 *
 * A leading `AND`, `OR`, `&&` or `||` is a Liqe syntax error. The scanner
 * used to skip `&` and `|`, so `&& status:open` looked like `status:open`.
 * The symbol is not removed. `NOT status:open` still excludes the open row.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open' },
  { id: 2, status: 'done' }
];

describe('leading operator', () => {
  const parser = new QueryParser();

  it.each([
    ['AND status:open', 'Syntax error at line 1 column 4'],
    ['OR status:open', 'Syntax error at line 1 column 3'],
    ['&& status:open', 'Syntax error at line 1 column 1'],
    ['|| status:open', 'Syntax error at line 1 column 1'],
    [' && status:open', 'Syntax error at line 1 column 2'],
    ['\t|| status:open', 'Syntax error at line 1 column 2']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    expect(parser.parseWithContext(query).recovery?.autofix).toBeUndefined();
  });

  it('keeps NOT status:open a negation that excludes the open row', () => {
    expect(isInputComplete('NOT status:open')).toBe(true);
    const expression = parser.parse('NOT status:open');
    expect(expression).toEqual({
      type: 'logical',
      operator: 'NOT',
      left: {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'open'
      }
    });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`NOT ("status" = 'open')`);
    expect(
      new SqlTranslator({ useParameters: true }).translate(expression)
    ).toEqual({ sql: 'NOT ("status" = ?)', params: ['open'] });
    expect(filterInMemory('NOT status:open', rows).map(row => row.id)).toEqual([
      2
    ]);
  });

  it('keeps status:open matching the open row', () => {
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([1]);
  });

  it.each([
    ['status:"&& open"', '&& open'],
    ["status:'|| open'", '|| open']
  ])('keeps %p as the quoted value %p', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: '==', value });
    expect(filterInMemory(query, rows)).toEqual([]);
  });

  it.each(['name:/&&/', 'name:/||/'])('keeps %p a regex', query => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: 'REGEX' });
  });
});
