/**
 * Stray sigil.
 *
 * `;`, `^` and `~` are not Liqe value characters, so each is a syntax error
 * outside quotes and regex. `status:open?` stays a wildcard and matches the
 * `openX` row, not the open rows.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'open', label: 'x' },
  { id: 2, status: 'open', label: 'y' },
  { id: 3, status: 'openX', label: 'x' }
];

describe('stray sigil', () => {
  const parser = new QueryParser();

  it.each([
    ['status:open;', 'Syntax error at line 1 column 12'],
    ['^status:open', 'Syntax error at line 1 column 1'],
    ['status:open ~ label:x', 'Syntax error at line 1 column 13'],
    [';status:open', 'Syntax error at line 1 column 1'],
    ['status:open ;', 'Syntax error at line 1 column 13'],
    ['~status:open', 'Syntax error at line 1 column 1'],
    ['status:open~', 'Syntax error at line 1 column 12'],
    ['status:open~label:x', 'Syntax error at line 1 column 12'],
    ['(status:open;)', 'Syntax error at line 1 column 13'],
    ['(^status:open)', 'Syntax error at line 1 column 2'],
    ['(status:open ~ label:x)', 'Syntax error at line 1 column 14'],
    ['priority:^2', 'Syntax error at line 1 column 10'],
    ['&status:open', 'Syntax error at line 1 column 1'],
    ['|status:open', 'Syntax error at line 1 column 1']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it('keeps status:open? a one-character wildcard', () => {
    expect(isInputComplete('status:open?')).toBe(true);
    const expression = parser.parse('status:open?');
    expect(expression).toMatchObject({ operator: 'LIKE', value: 'open?' });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"status" LIKE 'open_' ESCAPE '!'`);
    expect(
      new SqlTranslator({ useParameters: true }).translate(expression)
    ).toEqual({ sql: `"status" LIKE ? ESCAPE '!'`, params: ['open_'] });
    expect(filterInMemory('status:open?', rows).map(row => row.id)).toEqual([
      3
    ]);
  });

  it('keeps status:open matching the open rows', () => {
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([
      1, 2
    ]);
  });

  it.each([
    ['status:"open;"', 'open;'],
    ["status:'^'", '^'],
    ['status:"~"', '~'],
    ['status:"a;b"', 'a;b'],
    ["status:'^~;'", '^~;']
  ])('keeps %p as the quoted value %p', (query, value) => {
    expect(isInputComplete(query)).toBe(true);
    expect(parser.parse(query)).toMatchObject({ operator: '==', value });
    expect(filterInMemory(query, rows)).toEqual([]);
  });

  it.each(['name:/;/', 'name:/^/', 'name:/~/', 'name:/[^/]+/i'])(
    'keeps %p a regex',
    query => {
      expect(isInputComplete(query)).toBe(true);
      expect(parser.parse(query)).toMatchObject({ operator: 'REGEX' });
    }
  );
});
