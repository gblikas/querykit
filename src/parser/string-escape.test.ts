/**
 * Quoted backslash.
 *
 * Liqe's string grammar accepts `\"`, `\/`, `\\`, `\b`, `\f`, `\n`, `\r`,
 * `\t`, `\u` plus four hex digits, and `\'` in single quotes only. Any other
 * backslash sequence is a syntax error; the search box is incomplete for it
 * and `\q` is not read as `q`.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, label: 'a\nb' },
  { id: 2, label: 'a\\nb' },
  { id: 3, label: 'a\tb' },
  { id: 4, label: 'aq' },
  { id: 5, label: 'A' },
  { id: 6, label: 'a"' },
  { id: 7, label: '\\' }
];

describe('quoted backslash', () => {
  const parser = new QueryParser();

  it.each([
    ['label:"a\\nb"', 'a\nb', [1]],
    ['label:"a\\tb"', 'a\tb', [3]],
    ['label:"\\u0041"', 'A', [5]],
    ['label:"a\\""', 'a"', [6]],
    ['label:"\\\\"', '\\', [7]],
    ["label:'a\\'b'", "a'b", []],
    ['label:"\\\\q"', '\\q', []],
    ['label:"a\\/b"', 'a/b', []],
    ['label:"\\b"', '\b', []],
    ['label:"\\f"', '\f', []],
    ['label:"\\r"', '\r', []],
    ['label:"\\u00e9"', '\u00e9', []]
  ])('keeps %p complete with the decoded value %p', (query, value, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toMatchObject({ operator: '==', value });
    expect(
      new SqlTranslator({ useParameters: true }).translate(expression)
    ).toEqual({ sql: '"label" = ?', params: [value] });
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });

  it.each([
    ['label:"a\\q"', 'Syntax error at line 1 column 10'],
    ['label:"\\U0041"', 'Syntax error at line 1 column 9'],
    ['label:"\\u12"', 'Syntax error at line 1 column 12'],
    ['label:"a\\\'b"', 'Syntax error at line 1 column']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
  });

  it('keeps a backslash that consumes the closer unclosed', () => {
    expect(isInputComplete('label:"a\\"')).toBe(false);
    expect(() => parser.parse('label:"a\\"')).toThrow(QueryParseError);
    expect(isInputComplete('label:"a""b"')).toBe(false);
  });
});
