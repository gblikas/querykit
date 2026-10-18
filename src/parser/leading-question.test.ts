/**
 * Leading question mark.
 *
 * A `?` may start or sit inside an unquoted value, where it is a wildcard.
 * Outside quotes, regex and values it begins a value with no field, and the
 * colon after `?status` is a syntax error. The question mark stays in the
 * text.
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

describe('leading question mark', () => {
  const parser = new QueryParser();

  it.each([
    ['?status:open', 'Syntax error at line 1 column 8'],
    ['status:open ?label:x', 'Syntax error at line 1 column 19'],
    ['(?status:open)', 'Syntax error at line 1 column 9'],
    ['?status:open label:x', 'Syntax error at line 1 column 8'],
    ['NOT ?status:open', 'Syntax error at line 1 column 12'],
    ['status:open OR ?label:x', 'Syntax error at line 1 column 22'],
    ['label:x ?status:open', 'Syntax error at line 1 column 16'],
    ['(status:open)?', 'Syntax error at line 1 column 14'],
    ['name:/foo/?', 'Found no parsings.'],
    ['status:open?label:x', 'Syntax error at line 1 column 18']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it.each([
    ['status:open ?', 'Implicit field search'],
    ['status:open ? label:x', 'Implicit field search']
  ])('keeps %p incomplete with the implicit-field error', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(message);
  });

  it.each([
    ['status:open??', 'open??', `"status" LIKE 'open__' ESCAPE '!'`, []],
    ['status:open?', 'open?', `"status" LIKE 'open_' ESCAPE '!'`, [3]],
    ['status:"?"', '?', `"status" LIKE '_' ESCAPE '!'`, []]
  ])('keeps %p the wildcard %p', (query, value, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ operator: 'LIKE', value });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each([
    'status:?open',
    'status:op?en',
    'status:open?label',
    'status:open AND label:?',
    'status:"open?"',
    '(status:open??)'
  ])('keeps %p complete and parseable', query => {
    expect(isInputComplete(query)).toBe(true);
    expect(() => parser.parse(query)).not.toThrow();
  });

  it('keeps a question mark as a quoted field name and a regex body', () => {
    expect(isInputComplete('"?":open')).toBe(true);
    expect(parser.parse('"?":open')).toMatchObject({ field: '?' });
    expect(isInputComplete('name:/?/')).toBe(true);
    expect(parser.parse('name:/?/')).toMatchObject({ operator: 'REGEX' });
    expect(filterInMemory('status:open', rows).map(row => row.id)).toEqual([
      1, 2
    ]);
  });
});
