/**
 * Block comment.
 *
 * Liqe reads a closed `/* note *\/` as a regex with no field, so `parse`
 * throws the implicit-field error; the unclosed note finds no parsing. The
 * search box is incomplete for all three and strips none of them down to
 * `status:open`. A star inside a field regex stays in the pattern.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open' },
  { id: 2, status: 'done' }
];

const IMPLICIT_FIELD =
  'Implicit field search is not supported; queries must name a field';

describe('block comment', () => {
  const parser = new QueryParser();

  it.each([
    ['status:open /* note */', IMPLICIT_FIELD],
    ['status:open /* note', 'Found no parsings.'],
    ['/* note */ status:open', IMPLICIT_FIELD]
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
  });

  it('keeps status:open complete', () => {
    expect(isInputComplete('status:open')).toBe(true);
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([1]);
  });

  it('keeps a star inside a field regex in the pattern', () => {
    expect(isInputComplete('status:/*open/')).toBe(true);
    expect(parser.parse('status:/*open/')).toEqual({
      type: 'comparison',
      field: 'status',
      operator: 'REGEX',
      value: '/*open/'
    });
    expect(() => filterInMemory('status:/*open/', rows)).toThrow(
      'Unsupported operator: REGEX'
    );
  });

  it('keeps a quoted note as a LIKE value', () => {
    const query = 'status:"/* note */"';
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ operator: 'LIKE', value: '/* note */' });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"status" LIKE '/% note %/' ESCAPE '!'`);
    expect(filterInMemory(query, rows)).toEqual([]);
  });
});
