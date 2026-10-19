/**
 * Single symbol.
 *
 * A single `&` or `|` outside quotes and regex is a Liqe syntax error:
 * between clauses, glued to a clause, or at either end. The symbol stays in
 * the text and is not compiled as a conjunction.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open', label: 'x' },
  { id: 2, status: 'open', label: 'y' },
  { id: 3, status: 'done', label: 'x' }
];

describe('single symbol', () => {
  const parser = new QueryParser();

  it.each([
    ['status:open & label:x', 'Syntax error at line 1 column 13'],
    ['&status:open', 'Syntax error at line 1 column 1'],
    ['status:open | label:x', 'Syntax error at line 1 column 13'],
    ['|status:open', 'Syntax error at line 1 column 1'],
    ['status:open && label:x', 'Syntax error at line 1 column 13'],
    ['status:open || label:x', 'Syntax error at line 1 column 13'],
    ['status:open&label:x', 'Syntax error at line 1 column 12'],
    ['status:open|label:x', 'Syntax error at line 1 column 12'],
    ['& status:open', 'Syntax error at line 1 column 1'],
    ['| status:open', 'Syntax error at line 1 column 1'],
    ['status:open &', 'Syntax error at line 1 column 13'],
    ['status:open |', 'Syntax error at line 1 column 13'],
    ['status:open&', 'Syntax error at line 1 column 12'],
    ['status:open|', 'Syntax error at line 1 column 12'],
    ['(status:open & label:x)', 'Syntax error at line 1 column 14'],
    ['(&status:open)', 'Syntax error at line 1 column 2'],
    ['(|status:open)', 'Syntax error at line 1 column 2']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it('keeps the word AND complete and agreed', () => {
    const query = 'status:open AND label:x';
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`("status" = 'open') AND ("label" = 'x')`);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([1]);
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([
      1, 2
    ]);
  });

  it.each([
    ['status:"&"', '&'],
    ["status:'|'", '|'],
    ['status:"& open"', '& open'],
    ["status:'| open'", '| open']
  ])('keeps %p as the quoted value %p', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: '==', value });
    expect(filterInMemory(query, rows)).toEqual([]);
  });

  it.each(['name:/&/', 'name:/|/', 'name:/a&b/', 'name:/a|b/'])(
    'keeps %p a regex',
    query => {
      expect(isInputComplete(query)).toBe(true);
      expect(parser.parse(query)).toMatchObject({ operator: 'REGEX' });
    }
  );
});
