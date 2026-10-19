/**
 * Bang negation.
 *
 * Liqe's negation is the word `NOT` or a leading minus; a bare `!` is a
 * syntax error. The bang is not removed and is not compiled as `NOT`. The
 * `!` of `:!=` is part of the not-equals operator.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open', label: 'a' },
  { id: 2, status: 'closed', label: 'b' }
];

describe('bang negation', () => {
  const parser = new QueryParser();

  it.each([
    ['!status:open', 'Syntax error at line 1 column 1'],
    ['!(status:open)', 'Syntax error at line 1 column 1'],
    ['! status:open', 'Syntax error at line 1 column 1'],
    ['status:!open', 'Syntax error at line 1 column 8'],
    ['status:open AND !label:a', 'Syntax error at line 1 column 17'],
    ['!status:open AND label:a', 'Syntax error at line 1 column 1']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    expect(parser.parseWithContext(query).recovery?.autofix).toBeUndefined();
  });

  it.each(['NOT status:open', 'status:!=open'])(
    'keeps %p a negation that excludes the open row',
    query => {
      expect(isInputComplete(query)).toBe(true);
      const expression = parser.parse(query);
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
      expect(filterInMemory(query, rows).map(row => row.id)).toEqual([2]);
    }
  );

  it('keeps status:open matching the open row', () => {
    expect(isInputComplete('status:open')).toBe(true);
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([1]);
  });

  it.each([
    ['status:"!open"', '!open'],
    ["status:'!open'", '!open']
  ])('keeps %p as the quoted value %p', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: '==', value });
    expect(filterInMemory(query, rows)).toEqual([]);
  });

  it.each(['name:/!/', 'name:/!open/'])('keeps %p a regex', query => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: 'REGEX' });
  });
});
