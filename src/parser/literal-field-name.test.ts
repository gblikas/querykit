/**
 * Field names the translators must keep as one identifier.
 *
 * An unquoted `a.b` is a `table.column` qualifier. A quoted `"a.b"` is one
 * column named `a.b`, and so are `"table."`, `".column"` and the unquoted
 * `column.`, whose empty side names no table. The parser marks those
 * comparisons `isLiteral: true`; the property is omitted otherwise, so an
 * existing `toEqual` on a plain comparison is unchanged. A `fieldMappings`
 * entry that replaces the name drops the flag, since the mapped name is the
 * schema's own spelling; case folding keeps it.
 *
 * These are the parser-level cases of docs/bugs/quoted-dots.md,
 * quoted-empty-side.md and leading-dot.md. The identifier quoting and the
 * row reads those reports pin (`src/parser/quoted-dots.test.ts`,
 * `quoted-empty-side.test.ts`, `leading-dot.test.ts`) land with the
 * translators and the in-memory adapter; the completeness of `.column:open`
 * is the input parser's rule.
 */

import { isInputComplete } from './input-parser';
import { QueryParseError, QueryParser } from './parser';
import { IComparisonExpression } from './types';

function literal(
  field: string,
  value: IComparisonExpression['value'] = 'open'
): IComparisonExpression {
  return { type: 'comparison', field, operator: '==', value, isLiteral: true };
}

function plain(
  field: string,
  value: IComparisonExpression['value'] = 'open'
): IComparisonExpression {
  return { type: 'comparison', field, operator: '==', value };
}

describe('literal field names', () => {
  const parser = new QueryParser();

  it.each(['"a.b":open', "'a.b':open"])(
    'marks the quoted dotted name %s as one identifier',
    query => {
      expect(parser.parse(query)).toEqual(literal('a.b'));
    }
  );

  it.each([
    ['"table.":open', 'table.'],
    ["'table.':open", 'table.'],
    ['".column":open', '.column'],
    ["'.column':open", '.column']
  ])(
    'marks the quoted name with an empty side %s as one identifier',
    (query, field) => {
      expect(parser.parse(query)).toEqual(literal(field));
    }
  );

  it('marks the unquoted name with an empty trailing side as one identifier', () => {
    expect(parser.parse('column.:open')).toEqual(literal('column.'));
  });

  it('leaves an unquoted qualifier, a two-dot name and a lone dot unmarked', () => {
    expect(parser.parse('a.b:open')).toEqual(plain('a.b'));
    expect(parser.parse('a..b:open')).toEqual(plain('a..b'));
    expect(parser.parse('"a.b.c":open')).toEqual(plain('a.b.c'));
    expect(parser.parse('"table..column":open')).toEqual(
      plain('table..column')
    );
    expect(parser.parse('"..":open')).toEqual(plain('..'));
    expect(parser.parse('".":open')).toEqual(plain('.'));
    expect(parser.parse('"status":open')).toEqual(plain('status'));
    expect(parser.parse('status:open')).toEqual(plain('status'));
  });

  it('still rejects an unquoted name with an empty leading side', () => {
    expect(() => parser.parse('.column:open')).toThrow(QueryParseError);
    expect(() => parser.parse('.column:open')).toThrow(
      'Failed to parse query: Syntax error at line 1 column 1'
    );
    expect(isInputComplete('.column:open')).toBe(false);
    const context = parser.parseWithContext('.column:open');
    expect(context.structure.isComplete).toBe(false);
    expect(context.success).toBe(false);
    expect(context.recovery?.autofix).toBeUndefined();
    expect(isInputComplete('column.:open')).toBe(true);
    expect(isInputComplete('".column":open')).toBe(true);
  });

  it('carries the flag on every comparison the field produces', () => {
    expect(parser.parse('"a.b":>1')).toEqual({
      type: 'comparison',
      field: 'a.b',
      operator: '>',
      value: 1,
      isLiteral: true
    });
    expect(parser.parse('"a.b":[1 TO 2]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: { ...literal('a.b', 1), operator: '>=' },
      right: { ...literal('a.b', 2), operator: '<=' }
    });
    expect(parser.parse('"a.b":in[1, 2]')).toEqual({
      ...literal('a.b', [1, 2]),
      operator: 'IN'
    });
    expect(parser.parse('"a.b":/x/')).toEqual({
      ...literal('a.b', '/x/'),
      operator: 'REGEX'
    });
    expect(parser.parse('"a.b":op*')).toEqual({
      ...literal('a.b', 'op*'),
      operator: 'LIKE'
    });
    expect(parser.parse('"a.b":!=open')).toEqual({
      type: 'logical',
      operator: 'NOT',
      left: literal('a.b')
    });
  });

  it('drops the flag when a field mapping replaces the name', () => {
    const mapped = new QueryParser({ fieldMappings: { 'a.b': 'owner.city' } });
    expect(mapped.parse('"a.b":open')).toEqual(plain('owner.city'));
    const mappedToLiteral = new QueryParser({
      fieldMappings: { city: 'owner.city' }
    });
    expect(mappedToLiteral.parse('city:open')).toEqual(plain('owner.city'));
  });

  it('keeps the flag under case folding', () => {
    const folding = new QueryParser({ caseInsensitiveFields: true });
    expect(folding.parse('"A.B":open')).toEqual(literal('a.b'));
    expect(folding.parse('"Table.":open')).toEqual(literal('table.'));
    expect(folding.parse('Column.:open')).toEqual(literal('column.'));
    expect(folding.parse('A.B:open')).toEqual(plain('a.b'));
  });

  it('reports the flag through parseWithContext', () => {
    const result = parser.parseWithContext('"a.b":open AND status:open');
    expect(result.success).toBe(true);
    expect(result.ast).toEqual({
      type: 'logical',
      operator: 'AND',
      left: literal('a.b'),
      right: plain('status')
    });
    expect(result.structure.referencedFields).toEqual(['a.b', 'status']);
  });
});
