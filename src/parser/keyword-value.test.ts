/**
 * Keyword value.
 *
 * An unquoted `AND`, `OR` or `NOT` as a value is Liqe's operator word, so
 * `status:AND` finds no parsing. Quoted keywords, `TO`, lowercase `and`
 * glued to the colon, and `in[AND]` are values on every engine.
 */

import { filterInMemory } from '../adapters/memory';
import { SqlTranslator } from '../translators/sql';
import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';

const rows = [
  { id: 1, status: 'AND', label: 'x' },
  { id: 2, status: 'and', label: 'x' },
  { id: 3, status: 'TO', label: 'x' },
  { id: 4, status: 'NOT', label: 'x' },
  { id: 5, status: 'open', label: 'x' }
];

describe('keyword value', () => {
  const parser = new QueryParser();

  it.each([
    ['status:AND', 'Found no parsings.'],
    ['status:OR', 'Found no parsings.'],
    ['status:NOT', 'Found no parsings.'],
    ['status:>AND', 'Found no parsings.'],
    ['status:>=AND', 'Found no parsings.'],
    ['status:<AND', 'Found no parsings.'],
    ['status:<=AND', 'Found no parsings.'],
    ['status:=AND', 'Found no parsings.'],
    ['status:!=AND', 'Found no parsings.'],
    ['-status:AND', 'Found no parsings.'],
    ['NOT status:AND', 'Found no parsings.'],
    ['"status":AND', 'Found no parsings.'],
    ["'status':AND", 'Found no parsings.'],
    ['(status:AND)', 'Syntax error at line 1 column 12'],
    ['status:AND AND label:x', 'Syntax error at line 1 column 11'],
    ['status:AND label:x', 'Syntax error at line 1 column 11'],
    ['status:AND OR label:x', 'Syntax error at line 1 column 11'],
    ['status:NOT AND label:x', 'Syntax error at line 1 column 11'],
    ['status:NOT NOT label:x', 'Syntax error at line 1 column 11'],
    ['label:x AND status:AND', 'Found no parsings.'],
    ['status:open OR status:AND', 'Found no parsings.'],
    ['status:open AND NOT status:AND', 'Found no parsings.'],
    ['status:open AND -status:AND', 'Found no parsings.']
  ])('treats %p as incomplete and rejected', (query, message) => {
    expect(isInputComplete(query)).toBe(false);
    expect(() => parser.parse(query)).toThrow(QueryParseError);
    expect(() => parser.parse(query)).toThrow(message);
    expect(() => filterInMemory(query, rows)).toThrow(QueryParseError);
    const context = parser.parseWithContext(query);
    expect(context.structure.isComplete).toBe(false);
    expect(context.success).toBe(false);
    if (!/^["']/.test(query)) {
      // A quoted field name is a bare value to the tokenizer, so recovery
      // reads the keyword as a trailing operator there; its autofix
      // `"status":` has no value and cannot parse either.
      expect(context.recovery?.autofix).toBeUndefined();
    }
  });

  it.each([
    ['status:TO', `"status" = 'TO'`, [3]],
    ['status:and', `"status" = 'and'`, [2]],
    ['status:"AND"', `"status" = 'AND'`, [1]],
    ["status:'AND'", `"status" = 'AND'`, [1]],
    ['status:"NOT"', `"status" = 'NOT'`, [4]],
    ['status:"OR"', `"status" = 'OR'`, []],
    ['status:And', `"status" = 'And'`, []],
    ['status:ANDx', `"status" = 'ANDx'`, []],
    ['status:open AND label:x', `("status" = 'open') AND ("label" = 'x')`, [5]],
    ['status:open and label:x', `("status" = 'open') AND ("label" = 'x')`, [5]],
    ['status:"AND" AND label:x', `("status" = 'AND') AND ("label" = 'x')`, [1]],
    ['status:and AND label:x', `("status" = 'and') AND ("label" = 'x')`, [2]],
    ['status:TO AND label:x', `("status" = 'TO') AND ("label" = 'x')`, [3]],
    ['status:in[AND]', `"status" IN ('AND')`, [1]]
  ])('keeps %p complete with inline SQL %p', (query, sql, ids) => {
    expect(isInputComplete(query)).toBe(true);
    const expression = parser.parse(query);
    expect(
      new SqlTranslator({ useParameters: false }).translate(expression)
    ).toBe(sql);
    expect(filterInMemory(query, rows).map(row => row.id)).toEqual(ids);
  });
});
