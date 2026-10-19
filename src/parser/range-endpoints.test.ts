/**
 * Null and boolean words as range endpoints.
 *
 * The bracket rewrite quoted an unquoted `null`, `true` or `false` bound,
 * so `priority:[1 TO null]` compared the column with the text `"null"` and
 * `active:[false TO true]` with the texts `"false"` and `"true"`, which a
 * boolean-mode column then encoded as 1. Neither word is a bound any engine
 * can order by, so the rewrite now leaves such a range to Liqe, which
 * rejects it. Quoted bounds stay strings, and the words keep their meaning
 * everywhere else.
 *
 * These are the parser-level cases of docs/bugs/null-range.md and
 * bool-range.md; their `isInputComplete` assertions are the input parser's
 * rule and land with the search box.
 */

import { QueryParseError, QueryParser } from './parser';
import { IComparisonExpression, QueryExpression } from './types';

function comparison(
  field: string,
  operator: IComparisonExpression['operator'],
  value: IComparisonExpression['value']
): IComparisonExpression {
  return { type: 'comparison', field, operator, value };
}

describe('null and boolean range endpoints', () => {
  const parser = new QueryParser();

  it.each([
    ['priority:[null TO 3]', 11],
    ['priority:[1 TO null]', 16],
    ['priority:{null TO 3}', 11],
    ['priority:[null TO *]', 11],
    ['priority:[* TO null]', 11],
    ['priority:[null TO null]', 11]
  ])(
    'rejects %s instead of comparing with the text "null"',
    (query, column) => {
      const parse = (): QueryExpression => parser.parse(query);
      expect(parse).toThrow(QueryParseError);
      expect(parse).toThrow(
        `Failed to parse query: Syntax error at line 1 column ${column}`
      );
      expect(parser.parseWithContext(query).success).toBe(false);
    }
  );

  it.each([
    'active:[false TO true]',
    'active:{false TO true}',
    'active:[false TO true}',
    'active:[true TO *]',
    'active:[* TO false]'
  ])(
    'rejects %s instead of comparing with the texts "false" and "true"',
    query => {
      const parse = (): QueryExpression => parser.parse(query);
      expect(parse).toThrow(QueryParseError);
      expect(parse).toThrow(
        'Failed to parse query: Syntax error at line 1 column 9'
      );
      expect(parser.parseWithContext(query).success).toBe(false);
    }
  );

  it('keeps quoted bounds as strings', () => {
    expect(parser.parse('priority:["null" TO "z"]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('priority', '>=', 'null'),
      right: comparison('priority', '<=', 'z')
    });
    expect(parser.parse('active:["false" TO "true"]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('active', '>=', 'false'),
      right: comparison('active', '<=', 'true')
    });
    expect(parser.parse('active:{"false" TO "true"}')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('active', '>', 'false'),
      right: comparison('active', '<', 'true')
    });
  });

  it('keeps the words as values outside a range', () => {
    expect(parser.parse('priority:<=null')).toEqual(
      comparison('priority', '<=', null)
    );
    expect(parser.parse('priority:in[1, null]')).toEqual(
      comparison('priority', 'IN', [1, null])
    );
    expect(parser.parse('priority:[null]')).toEqual(
      comparison('priority', '==', null)
    );
    expect(parser.parse('active:false')).toEqual(
      comparison('active', '==', false)
    );
    expect(parser.parse('active:<=false')).toEqual(
      comparison('active', '<=', false)
    );
    expect(parser.parse('active:[false, true]')).toEqual({
      type: 'logical',
      operator: 'OR',
      left: comparison('active', '==', false),
      right: comparison('active', '==', true)
    });
  });

  it('keeps numeric and word ranges as they were', () => {
    expect(parser.parse('priority:[1 TO 3]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('priority', '>=', 1),
      right: comparison('priority', '<=', 3)
    });
    expect(parser.parse('label:[and TO or]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('label', '>=', 'and'),
      right: comparison('label', '<=', 'or')
    });
    expect(parser.parse('label:[nul TO truer]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('label', '>=', 'nul'),
      right: comparison('label', '<=', 'truer')
    });
  });
});
