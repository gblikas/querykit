/**
 * Invariants for the query parser, found by comparing Liqe's grammar,
 * the input tokenizer, and parseWithContext validation on the same strings.
 */

import { QueryParser, QueryParseError } from './parser';
import { isInputComplete } from './input-parser';
import { parseQueryInput } from './tokenizer';
import {
  IComparisonExpression,
  ILogicalExpression,
  QueryExpression
} from './types';

describe('Parser invariants', () => {
  let parser: QueryParser;

  beforeEach(() => {
    parser = new QueryParser();
  });

  describe('documented range syntax', () => {
    it('parses an inclusive date range as two comparisons', () => {
      const inputQuery = 'dueDate:[2023-01-01 TO 2023-01-31]';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'comparison',
          field: 'dueDate',
          operator: '>=',
          value: '2023-01-01'
        },
        right: {
          type: 'comparison',
          field: 'dueDate',
          operator: '<=',
          value: '2023-01-31'
        }
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
    });

    it('parses an exclusive date range as two comparisons', () => {
      const inputQuery = 'dueDate:{2023-01-01 TO 2023-01-31}';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'comparison',
          field: 'dueDate',
          operator: '>',
          value: '2023-01-01'
        },
        right: {
          type: 'comparison',
          field: 'dueDate',
          operator: '<',
          value: '2023-01-31'
        }
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
    });

    it('parses a date range when the separator is lowercase', () => {
      const inputQuery = 'dueDate:[2023-01-01 to 2023-01-31]';
      const actual = parser.parse(inputQuery) as ILogicalExpression;
      expect(actual.operator).toBe('AND');
      expect((actual.left as IComparisonExpression).operator).toBe('>=');
      expect((actual.right as IComparisonExpression).operator).toBe('<=');
    });

    it('parses numeric ranges that have insignificant whitespace', () => {
      const inputQuery = 'id:[ 2 TO 5 ]';
      const expected = parser.parse('id:[2 TO 5]');
      expect(parser.parse(inputQuery)).toEqual(expected);
    });

    it('parses a half-bounded range', () => {
      const inputQuery = 'id:[* TO 10]';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'id',
        operator: '<=',
        value: 10
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
    });

    it('parses a string range whose bounds contain spaces', () => {
      const inputQuery = 'name:[John Doe TO Jane]';
      const actual = parser.parse(inputQuery) as ILogicalExpression;
      expect((actual.left as IComparisonExpression).value).toBe('John Doe');
      expect((actual.left as IComparisonExpression).operator).toBe('>=');
      expect((actual.right as IComparisonExpression).value).toBe('Jane');
      expect((actual.right as IComparisonExpression).operator).toBe('<=');
    });

    it('parses an IN list on a dotted field', () => {
      const inputQuery = 'user.name:[a, b]';
      const actual = parser.parse(inputQuery) as ILogicalExpression;
      expect(actual.operator).toBe('OR');
      expect(actual.left).toMatchObject({ field: 'user.name', value: 'a' });
      expect(actual.right).toMatchObject({ field: 'user.name', value: 'b' });
    });
  });

  describe('bracket lists are not ranges when TO is quoted', () => {
    it('keeps a quoted value that contains TO in an IN list', () => {
      const inputQuery = 'name:["A TO B", C]';
      const actual = parser.parse(inputQuery) as ILogicalExpression;
      expect(actual.operator).toBe('OR');
      expect((actual.left as IComparisonExpression).value).toBe('A TO B');
      expect((actual.right as IComparisonExpression).value).toBe('C');
    });

    it('keeps a single quoted value that contains to', () => {
      const inputQuery = 'tags:["a to b"]';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'tags',
        operator: '==',
        value: 'a to b'
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
    });

    it('does not rewrite bracket syntax that appears inside a quoted value', () => {
      const inputQuery = 'note:"status:[todo, doing]"';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'note',
        operator: '==',
        value: 'status:[todo, doing]'
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
    });
  });

  describe('regular expressions', () => {
    it('keeps a regex with wildcards as a regex instead of LIKE', () => {
      const inputQuery = 'name:/Todo.*/';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'REGEX',
        value: '/Todo.*/'
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
    });

    it('keeps a regex without wildcards as a regex instead of equality', () => {
      const inputQuery = 'name:/foo/';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'REGEX',
        value: '/foo/'
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
    });

    it('does not rewrite boolean words inside a regex literal', () => {
      const inputQuery = 'name:/foo and bar/';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'REGEX',
        value: '/foo and bar/'
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
      const parsed = parseQueryInput(inputQuery);
      expect(parsed.logicalOperators).toHaveLength(0);
      expect(parsed.terms).toHaveLength(1);
    });

    it('ignores parentheses inside a regex when measuring depth', () => {
      const inputQuery = 'name:/(a(b))/';
      const result = parser.parseWithContext(inputQuery, {
        securityOptions: { maxQueryDepth: 1 }
      });
      expect(result.success).toBe(true);
      expect(result.structure.depth).toBe(1);
      expect(result.security?.passed).toBe(true);
    });
  });

  describe('not-equals operator', () => {
    it('parses field:!=value as NOT field:value', () => {
      const inputQuery = 'status:!=active';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'NOT',
        left: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'active'
        }
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
    });

    it('binds not-equals tighter than AND', () => {
      const inputQuery = 'status:!=active AND priority:>2';
      const actual = parser.parse(inputQuery) as ILogicalExpression;
      expect(actual.operator).toBe('AND');
      expect((actual.left as ILogicalExpression).operator).toBe('NOT');
      expect(actual.right).toMatchObject({ field: 'priority', operator: '>' });
    });

    it('does not rewrite :!= inside a quoted value', () => {
      const inputQuery = 'note:"a:!=b"';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'note',
        operator: '==',
        value: 'a:!=b'
      };
      expect(parser.parse(inputQuery)).toEqual(expected);
    });
  });

  describe('literals are not query structure', () => {
    it('treats an apostrophe inside double quotes as balanced', () => {
      const inputQuery = 'name:"it\'s"';
      const result = parser.parseWithContext(inputQuery);
      expect(result.success).toBe(true);
      expect(result.structure.hasBalancedQuotes).toBe(true);
      expect(result.structure.isComplete).toBe(true);
    });

    it('treats parentheses inside quotes as balanced', () => {
      const inputQuery = 'name:"foo)"';
      const result = parser.parseWithContext(inputQuery);
      expect(result.success).toBe(true);
      expect(result.structure.hasBalancedParentheses).toBe(true);
      expect(result.structure.isComplete).toBe(true);
    });

    it('treats an escaped quote as closed', () => {
      const inputQuery = 'name:"a\\"b"';
      const result = parser.parseWithContext(inputQuery);
      expect(result.success).toBe(true);
      expect(result.structure.hasBalancedQuotes).toBe(true);
      expect(result.structure.isComplete).toBe(true);
    });

    it('does not count parentheses inside a string toward query depth', () => {
      const inputQuery = 'note:"((draft))"';
      const result = parser.parseWithContext(inputQuery, {
        securityOptions: { maxQueryDepth: 1 }
      });
      expect(result.success).toBe(true);
      expect(result.structure.depth).toBe(1);
      expect(result.security?.passed).toBe(true);
    });

    it('treats a value that is the word or as a complete query', () => {
      const inputQuery = 'priority:>=or';
      const result = parser.parseWithContext(inputQuery);
      expect(result.success).toBe(true);
      expect(result.structure.isComplete).toBe(true);
    });

    it('closes the double quote when an apostrophe is also present', () => {
      const inputQuery = 'name:"it\'s';
      const result = parser.parseWithContext(inputQuery);
      expect(result.success).toBe(false);
      expect(result.recovery?.issue).toBe('unclosed_quote');
      expect(result.recovery?.message).toMatch(/double/i);
      expect(result.recovery?.autofix).toBe('name:"it\'s"');
    });
  });

  describe('security checks follow the executed AST', () => {
    it('denies a field hidden behind unary minus', () => {
      const inputQuery = '-password:secret';
      const result = parser.parseWithContext(inputQuery, {
        securityOptions: { denyFields: ['password'] }
      });
      expect(result.success).toBe(true);
      expect(result.ast).toMatchObject({
        operator: 'NOT',
        left: { field: 'password' }
      });
      expect(result.structure.referencedFields).toContain('password');
      expect(result.security?.passed).toBe(false);
      expect(result.security?.violations).toContainEqual(
        expect.objectContaining({ type: 'denied_field', field: 'password' })
      );
    });

    it('denies a quoted field name', () => {
      const inputQuery = '"password":secret';
      const result = parser.parseWithContext(inputQuery, {
        securityOptions: { denyFields: ['password'] }
      });
      expect(result.success).toBe(true);
      expect(result.structure.referencedFields).toEqual(['password']);
      expect(result.security?.passed).toBe(false);
    });

    it('denies a field after name mapping', () => {
      const mapped = new QueryParser({ fieldMappings: { pwd: 'password' } });
      const result = mapped.parseWithContext('pwd:secret', {
        securityOptions: { denyFields: ['password'] }
      });
      expect(result.success).toBe(true);
      expect(result.ast).toMatchObject({ field: 'password' });
      expect(result.security?.passed).toBe(false);
    });

    it('denies a field when field names are case-insensitive', () => {
      const insensitive = new QueryParser({ caseInsensitiveFields: true });
      const result = insensitive.parseWithContext('PASSWORD:secret', {
        securityOptions: { denyFields: ['password'] }
      });
      expect(result.success).toBe(true);
      expect(result.ast).toMatchObject({ field: 'password' });
      expect(result.security?.passed).toBe(false);
    });

    it('counts comparisons in a spaceless IN list', () => {
      const inputQuery = 'status:[a,b,c]';
      const result = parser.parseWithContext(inputQuery, {
        securityOptions: { maxClauseCount: 2 }
      });
      expect(result.success).toBe(true);
      expect(result.structure.clauseCount).toBe(3);
      expect(result.security?.passed).toBe(false);
    });

    it('does not count the range keyword as an extra clause', () => {
      const inputQuery = 'id:[2 TO 5]';
      const result = parser.parseWithContext(inputQuery, {
        securityOptions: { maxClauseCount: 2 }
      });
      expect(result.success).toBe(true);
      expect(result.structure.clauseCount).toBe(2);
      expect(result.security?.passed).toBe(true);
    });
  });

  describe('implicit field search', () => {
    it('rejects a bare term with a field error', () => {
      const caseSensitive = new QueryParser();
      const caseInsensitive = new QueryParser({ caseInsensitiveFields: true });
      for (const subject of [caseSensitive, caseInsensitive]) {
        expect(() => subject.parse('foo')).toThrow(QueryParseError);
        try {
          subject.parse('foo');
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          expect(message).not.toMatch(/toLowerCase/);
          expect(message).toMatch(/field/i);
        }
      }
    });
  });

  describe('inherited property names', () => {
    it('keeps inherited property names as field names', () => {
      const expectedDone: IComparisonExpression = {
        type: 'comparison',
        field: 'toString',
        operator: '==',
        value: 'done'
      };
      expect(parser.parse('toString:done')).toEqual(expectedDone);
      expect(parser.parse('constructor:done')).toEqual({
        ...expectedDone,
        field: 'constructor'
      });
      const mapped = new QueryParser({ fieldMappings: { toString: 'title' } });
      expect(mapped.parse('toString:done')).toEqual({
        ...expectedDone,
        field: 'title'
      });
    });

    it('keeps a backslash in a bracket value that has a space', () => {
      const expression = parser.parse('note:[a\\b c, d]');
      expect(expression).toEqual({
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'comparison',
          field: 'note',
          operator: '==',
          value: 'a\\b c'
        },
        right: {
          type: 'comparison',
          field: 'note',
          operator: '==',
          value: 'd'
        }
      });
    });

    it('reports an inherited property name as an unknown schema field', () => {
      const result = parser.parseWithContext('toString:done', {
        schema: {
          status: { type: 'string' }
        }
      });
      expect(result.success).toBe(true);
      expect(result.fieldValidation?.valid).toBe(false);
      expect(result.fieldValidation?.unknownFields).toEqual(['toString']);
    });
  });

  describe('raw line feed inside quotes', () => {
    it.each(['name:"foo\nbar"', "name:'foo\nbar'"])(
      'rejects %p and keeps one term',
      query => {
        expect(() => parser.parse(query)).toThrow(QueryParseError);
        expect(parseQueryInput(query).terms).toHaveLength(1);
      }
    );

    it('rejects a line feed inside a quoted membership member', () => {
      expect(() => parser.parse('status:in["foo\nbar"]')).toThrow(
        QueryParseError
      );
    });

    it('keeps the two-character escape as a newline in the value', () => {
      expect(parser.parse('name:"foo\\nbar"')).toEqual({
        type: 'comparison',
        field: 'name',
        operator: '==',
        value: 'foo\nbar'
      });
    });
  });

  describe('regex spans follow Liqe', () => {
    const regexOf = (field: string, value: string): IComparisonExpression => ({
      type: 'comparison',
      field,
      operator: 'REGEX',
      value
    });

    it('keeps slash pairs that only parse as one regex inside the literal', () => {
      expect(parser.parse('name:/foo/) AND status:/bar/')).toEqual(
        regexOf('name', '/foo/) AND status:/bar/')
      );
      expect(isInputComplete('name:/foo/) AND status:/bar/')).toBe(true);
    });

    it('rejects two regex literals Liqe reads two ways', () => {
      expect(() => parser.parse('name:/foo/ AND status:/bar/')).toThrow(
        'Ambiguous results.'
      );
      expect(isInputComplete('name:/foo/ AND status:/bar/')).toBe(false);
    });

    it('parentheses keep two regex literals as two comparisons', () => {
      expect(parser.parse('name:/foo/ AND (status:/bar/)')).toEqual({
        type: 'logical',
        operator: 'AND',
        left: regexOf('name', '/foo/'),
        right: regexOf('status', '/bar/')
      });
      expect(isInputComplete('name:/foo/ AND (status:/bar/)')).toBe(true);
    });

    it('keeps a slash inside the regex body', () => {
      expect(parser.parse('name:/a/b/')).toEqual(regexOf('name', '/a/b/'));
      expect(isInputComplete('name:/a/b/')).toBe(true);
    });

    it('keeps a boolean word inside the regex body lowercase', () => {
      expect(parser.parse('name:/foo/not/bar/')).toEqual(
        regexOf('name', '/foo/not/bar/')
      );
    });

    it('still lifts a membership list beside a regex Liqe rejects as written', () => {
      expect(parser.parse('name:/foo/ AND tags:in[a, b]')).toEqual({
        type: 'logical',
        operator: 'AND',
        left: regexOf('name', '/foo/'),
        right: {
          type: 'comparison',
          field: 'tags',
          operator: 'IN',
          value: ['a', 'b']
        }
      });
    });
  });
});
