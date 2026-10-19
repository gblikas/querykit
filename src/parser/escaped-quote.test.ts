/**
 * Escaped quote.
 *
 * `\"` is the only way to put a double quote inside a double-quoted value.
 * A doubled quote closes the string and leaves a stray quote, which Liqe
 * rejects; the search box is incomplete for it instead of reading `a"b` or
 * `ab`. An unclosed quote keeps its closing-quote autofix.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, label: 'a"b' },
  { id: 2, label: 'a\\"b' },
  { id: 3, label: 'ab' }
];

describe('escaped quote', () => {
  const parser = new QueryParser();

  it('keeps the backslash escape as one quote in the value', () => {
    const query = 'label:"a\\"b"';
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(expression).toEqual({
      type: 'comparison',
      field: 'label',
      operator: '==',
      value: 'a"b'
    });
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(`"label" = 'a"b'`);
    expect(
      new SqlTranslator({ useParameters: true }).translate(expression)
    ).toEqual({ sql: '"label" = ?', params: ['a"b'] });
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual([1]);
  });

  it.each(['label:"a""b"', "label:'a''b'"])(
    'treats %p as incomplete and rejected',
    query => {
      expect(isInputComplete(query)).toBe(false);
      expect(() => parser.parse(query)).toThrow(QueryParseError);
      expect(() => parser.parse(query)).toThrow(
        'Syntax error at line 1 column 10'
      );
      expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
      const context = parser.parseWithContext(query);
      expect(context.structure.isComplete).toBe(false);
      expect(context.ast).toBeUndefined();
      expect(context.recovery?.autofix).toBeUndefined();
    }
  );

  it('keeps an unclosed quote on the unclosed-quote path with its autofix', () => {
    expect(isInputComplete('label:"ab')).toBe(false);
    expect(() => parser.parse('label:"ab')).toThrow('Found no parsings.');
    const context = parser.parseWithContext('label:"ab');
    expect(context.recovery?.issue).toBe('unclosed_quote');
    expect(context.recovery?.autofix).toBe('label:"ab"');
  });

  it('keeps an empty quoted field name complete', () => {
    expect(isInputComplete('"":a')).toBe(true);
  });
});
