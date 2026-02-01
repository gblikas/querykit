import { QueryParser, QueryParseError } from './parser';
import {
  IComparisonExpression,
  ILogicalExpression,
  QueryExpression
} from './types';

// Replace the type definition with this approach
type QueryParserPrivate = {
  convertLiqeAst(node: unknown): QueryExpression;
  convertLiqeOperator(operator: string): string;
  convertLiqeValue(
    value: unknown
  ): string | number | boolean | null | unknown[];
  normalizeFieldName(field: string): string;
};

describe('QueryParser', () => {
  let parser: QueryParser;

  beforeEach(() => {
    parser = new QueryParser();
  });

  describe('parse', () => {
    it('should parse simple comparison expressions', () => {
      const query = 'priority:>2';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'priority',
        operator: '>',
        value: 2
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse equality comparison expressions', () => {
      const query = 'priority:2';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'priority',
        operator: '==',
        value: 2
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse less than comparison expressions', () => {
      const query = 'priority:<2';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'priority',
        operator: '<',
        value: 2
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse less than or equal comparison expressions', () => {
      const query = 'priority:<=2';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'priority',
        operator: '<=',
        value: 2
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse greater than or equal comparison expressions', () => {
      const query = 'priority:>=2';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'priority',
        operator: '>=',
        value: 2
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse IN operator expressions', () => {
      const query = 'status:"active" OR status:"pending"';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'active'
        },
        right: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'pending'
        }
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse NOT IN operator expressions', () => {
      const query = 'NOT (status:"inactive" OR status:"closed")';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'NOT',
        left: {
          type: 'logical',
          operator: 'OR',
          left: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'inactive'
          },
          right: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'closed'
          }
        }
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse wildcard expressions', () => {
      const query = 'name:"John*"';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'LIKE',
        value: 'John*'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse logical AND expressions', () => {
      const query = 'priority:>2 AND status:active';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'comparison',
          field: 'priority',
          operator: '>',
          value: 2
        },
        right: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'active'
        }
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse logical OR expressions', () => {
      const query = 'status:active OR status:pending';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'active'
        },
        right: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'pending'
        }
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse NOT expressions', () => {
      const query = 'NOT status:inactive';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'NOT',
        left: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'inactive'
        }
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse parenthesized expressions', () => {
      const query = '(status:active OR status:pending) AND priority:>2';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'logical',
          operator: 'OR',
          left: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'active'
          },
          right: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'pending'
          }
        },
        right: {
          type: 'comparison',
          field: 'priority',
          operator: '>',
          value: 2
        }
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should handle case-insensitive fields when enabled', () => {
      const parser = new QueryParser({ caseInsensitiveFields: true });
      const query = 'STATUS:active';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'active'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should apply field mappings when provided', () => {
      const parser = new QueryParser({
        fieldMappings: { user_name: 'username' }
      });
      const query = 'user_name:john';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'username',
        operator: '==',
        value: 'john'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should throw QueryParseError for invalid queries', () => {
      const invalidQueries = ['', 'invalid:query:format', 'field:', ':value'];

      invalidQueries.forEach(query => {
        expect(() => parser.parse(query)).toThrow(QueryParseError);
      });
    });

    it('should throw QueryParseError for unsupported operators', () => {
      const query = 'priority:^2';
      expect(() => parser.parse(query)).toThrow(QueryParseError);
    });

    it('should throw QueryParseError for invalid AST nodes', () => {
      // This test simulates an internal error in the parser
      const mockLiqeAst = {} as unknown;
      expect(() =>
        parser['convertLiqeAst'](mockLiqeAst as import('liqe').LiqeQuery)
      ).toThrow(QueryParseError);
    });

    // New test cases start here
    it('should parse quoted string values', () => {
      const query = 'name:"John Doe"';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: '==',
        value: 'John Doe'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse boolean values', () => {
      const query = 'isActive:true';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'isActive',
        operator: '==',
        value: true
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse null values', () => {
      const query = 'lastName:null';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'lastName',
        operator: '==',
        value: null
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse complex nested expressions with multiple operators', () => {
      const query =
        '(name:"John" OR name:"Jane") AND (priority:>2 AND (isActive:true OR role:"admin"))';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'logical',
          operator: 'OR',
          left: {
            type: 'comparison',
            field: 'name',
            operator: '==',
            value: 'John'
          },
          right: {
            type: 'comparison',
            field: 'name',
            operator: '==',
            value: 'Jane'
          }
        },
        right: {
          type: 'logical',
          operator: 'AND',
          left: {
            type: 'comparison',
            field: 'priority',
            operator: '>',
            value: 2
          },
          right: {
            type: 'logical',
            operator: 'OR',
            left: {
              type: 'comparison',
              field: 'isActive',
              operator: '==',
              value: true
            },
            right: {
              type: 'comparison',
              field: 'role',
              operator: '==',
              value: 'admin'
            }
          }
        }
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should apply complex field mappings', () => {
      const parser = new QueryParser({
        fieldMappings: {
          user_name: 'username',
          user_priority: 'priority',
          user_active: 'isActive'
        }
      });

      const query = 'user_name:john AND user_priority:>2 AND user_active:true';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'logical',
          operator: 'AND',
          left: {
            type: 'comparison',
            field: 'username',
            operator: '==',
            value: 'john'
          },
          right: {
            type: 'comparison',
            field: 'priority',
            operator: '>',
            value: 2
          }
        },
        right: {
          type: 'comparison',
          field: 'isActive',
          operator: '==',
          value: true
        }
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should throw QueryParseError for invalid logical operator', () => {
      // Simulating an internal error when converting logical operators
      const mockLiqeAst = {
        type: 'LogicalExpression',
        operator: { operator: 'INVALID' },
        left: {
          type: 'Tag',
          field: { name: 'field' },
          expression: { value: 'value' },
          operator: { operator: ':' }
        }
      } as unknown;

      expect(() =>
        parser['convertLiqeAst'](
          mockLiqeAst as unknown as import('liqe').LiqeQuery
        )
      ).toThrow(QueryParseError);
    });

    it('should throw QueryParseError for invalid field or expression in Tag node', () => {
      // Simulating an internal error where field or expression is missing in a Tag node
      const mockLiqeAst = {
        type: 'Tag',
        operator: { operator: ':' }
      } as unknown;

      expect(() =>
        parser['convertLiqeAst'](
          mockLiqeAst as unknown as import('liqe').LiqeQuery
        )
      ).toThrow(QueryParseError);
    });

    it('should throw QueryParseError for invalid empty expression', () => {
      // Simulating an internal error for an invalid empty expression
      const mockLiqeAst = {
        type: 'EmptyExpression'
        // Missing 'left' property
      } as unknown;

      expect(() =>
        parser['convertLiqeAst'](
          mockLiqeAst as unknown as import('liqe').LiqeQuery
        )
      ).toThrow(QueryParseError);
    });

    it('should throw QueryParseError for invalid parenthesized expression', () => {
      // Simulating an internal error for an invalid parenthesized expression
      const mockLiqeAst = {
        type: 'ParenthesizedExpression'
        // Missing 'expression' property
      } as unknown;

      expect(() =>
        parser['convertLiqeAst'](
          mockLiqeAst as unknown as import('liqe').LiqeQuery
        )
      ).toThrow(QueryParseError);
    });

    it('should throw QueryParseError for unsupported value type', () => {
      // Create a mock Tag node with an unsupported value type (object)
      const mockLiqeAst = {
        type: 'Tag',
        field: { name: 'field' },
        operator: { operator: ':' },
        expression: { value: { unsupported: 'object' } }
      } as unknown;

      expect(() =>
        parser['convertLiqeAst'](mockLiqeAst as import('liqe').LiqeQuery)
      ).toThrow(QueryParseError);
    });

    it('should parse multiple field mappings in a single query', () => {
      const parser = new QueryParser({
        fieldMappings: {
          first_name: 'firstName',
          last_name: 'lastName'
        }
      });

      const query = 'first_name:John AND last_name:Doe';
      const expected: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'comparison',
          field: 'firstName',
          operator: '==',
          value: 'John'
        },
        right: {
          type: 'comparison',
          field: 'lastName',
          operator: '==',
          value: 'Doe'
        }
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    // New test cases to improve coverage
    it('should handle IN operator expressions with array values', () => {
      // This test is to handle the IN operator cases in convertLiqeOperator
      const mockLiqeAst = {
        type: 'Tag',
        field: { name: 'status' },
        operator: { operator: 'in' },
        expression: { value: ['active', 'pending'] }
      } as unknown;

      const result = parser['convertLiqeAst'](
        mockLiqeAst as import('liqe').LiqeQuery
      );
      expect(result).toEqual({
        type: 'comparison',
        field: 'status',
        operator: 'IN',
        value: ['active', 'pending']
      });
    });

    it('should handle NOT IN operator expressions with array values', () => {
      // This test is to handle the NOT IN operator cases in convertLiqeOperator
      const mockLiqeAst = {
        type: 'Tag',
        field: { name: 'status' },
        operator: { operator: 'not in' },
        expression: { value: ['inactive', 'deleted'] }
      } as unknown;

      const result = parser['convertLiqeAst'](
        mockLiqeAst as import('liqe').LiqeQuery
      );
      expect(result).toEqual({
        type: 'comparison',
        field: 'status',
        operator: 'NOT IN',
        value: ['inactive', 'deleted']
      });
    });

    it('should handle equality operator (=) expressions', () => {
      // Test for the '=' case in convertLiqeOperator
      const mockLiqeAst = {
        type: 'Tag',
        field: { name: 'priority' },
        operator: { operator: '=' },
        expression: { value: 2 }
      } as unknown;

      const result = parser['convertLiqeAst'](
        mockLiqeAst as import('liqe').LiqeQuery
      );
      expect(result).toEqual({
        type: 'comparison',
        field: 'priority',
        operator: '==',
        value: 2
      });
    });

    it('should handle array values in queries', () => {
      // Testing array handling in convertLiqeValue
      const mockLiqeAst = {
        type: 'Tag',
        field: { name: 'tags' },
        operator: { operator: ':' },
        expression: { value: ['important', 'urgent', 'critical'] }
      } as unknown;

      const result = parser['convertLiqeAst'](
        mockLiqeAst as import('liqe').LiqeQuery
      );
      expect(result).toEqual({
        type: 'comparison',
        field: 'tags',
        operator: '==',
        value: ['important', 'urgent', 'critical']
      });
    });

    it('should handle EmptyExpression with left property', () => {
      // Testing the EmptyExpression branch with a left property
      const mockLiqeAst = {
        type: 'EmptyExpression',
        left: {
          type: 'Tag',
          field: { name: 'status' },
          operator: { operator: ':' },
          expression: { value: 'active' }
        }
      } as unknown;

      const result = parser['convertLiqeAst'](
        mockLiqeAst as import('liqe').LiqeQuery
      );
      expect(result).toEqual({
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'active'
      });
    });

    it('should handle error details in QueryParseError', () => {
      try {
        // Force a specific error to test error handling in parse method
        parser['convertLiqeAst'] = (): QueryExpression => {
          const error = new Error('Test specific error message');
          throw error;
        };

        parser.parse('status:active');
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(QueryParseError);
        expect((error as Error).message).toContain(
          'Test specific error message'
        );
      } finally {
        // Restore original method
        parser['convertLiqeAst'] = jest.fn();
      }
    });

    it('should throw QueryParseError for non-Error exceptions', () => {
      try {
        // Force a non-Error exception to test that branch
        parser['convertLiqeAst'] = (): QueryExpression => {
          throw 'String exception'; // Not an Error object
        };

        parser.parse('status:active');
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(QueryParseError);
        expect((error as Error).message).toContain('String exception');
      } finally {
        // Restore original method
        parser['convertLiqeAst'] = jest.fn();
      }
    });

    // Additional tests to improve coverage further
    it('should handle explicit case when node type is not recognized', () => {
      // Testing line 78: unsupported node type branch
      const mockLiqeAst = {
        type: 'UnsupportedNodeType' // This should trigger the default case
      } as unknown;

      expect(() =>
        parser['convertLiqeAst'](mockLiqeAst as import('liqe').LiqeQuery)
      ).toThrow(QueryParseError);
    });

    it('should handle more complex field names in normalizeFieldName', () => {
      // Create a parser with both case insensitivity and field mappings
      // to exercise line 207 in normalizeFieldName
      const parser = new QueryParser({
        caseInsensitiveFields: true,
        fieldMappings: {
          'user_profile.name': 'userName',
          'user_profile.priority': 'userPriority'
        }
      });

      const mockLiqeAst = {
        type: 'Tag',
        field: { name: 'USER_PROFILE.NAME' }, // Upper case to test case insensitivity
        operator: { operator: ':' },
        expression: { value: 'John' }
      } as unknown;

      const result = parser['convertLiqeAst'](
        mockLiqeAst as import('liqe').LiqeQuery
      );
      expect(result).toEqual({
        type: 'comparison',
        field: 'userName', // Should be mapped and case-normalized
        operator: '==',
        value: 'John'
      });
    });

    it('should handle invalid parenthesized expression with undefined expression', () => {
      // This tests line 142 - when a parenthesized expression has an undefined expression
      const mockLiqeAst = {
        type: 'ParenthesizedExpression',
        expression: undefined
      } as unknown;

      expect(() =>
        parser['convertLiqeAst'](mockLiqeAst as import('liqe').LiqeQuery)
      ).toThrow(QueryParseError);
    });

    // Target line 78 specifically with correct typing
    it('should throw QueryParseError for unknown node types', () => {
      // We need to make sure line 78 executes by creating an object with a type property but not a known type
      const mockUnknownNode = {
        type: 'UnknownType'
      } as unknown as import('liqe').LiqeQuery;

      expect(() => parser['convertLiqeAst'](mockUnknownNode)).toThrowError(
        'Unsupported node type: UnknownType'
      );
    });

    // Target line 142 specifically - ParenthesizedExpression with undefined expression
    it('should throw QueryParseError for ParenthesizedExpression with undefined expression', () => {
      const mockParenNode = {
        type: 'ParenthesizedExpression',
        // Explicitly define expression as undefined to target line 142
        expression: undefined
      } as unknown as import('liqe').LiqeQuery;

      expect(() => parser['convertLiqeAst'](mockParenNode)).toThrowError(
        'Invalid parenthesized expression'
      );
    });

    // Target line 207 - the fallback case in normalizeFieldName
    it('should return the original field name when no mapping exists', () => {
      // Create a parser with field mappings that don't include the field we're testing
      const parser = new QueryParser({
        fieldMappings: {
          known_field: 'mappedField'
        }
      });

      // This should test line 207 by using an unmapped field
      const unmappedField = 'unmapped_field';
      const result = parser['normalizeFieldName'](unmappedField);

      // Should return the original field since there is no mapping
      expect(result).toBe(unmappedField);
    });

    it('should handle all cases in the switch statement of convertLiqeAst', () => {
      // Testing line 78: the last case in the switch statement
      // Create a direct mock of a node with an unknown type
      const mockNode = { type: 'CompletelyUnknownType' };

      try {
        // Need to call the method directly
        (parser as unknown as QueryParserPrivate).convertLiqeAst(mockNode);
        fail('Should have thrown an error');
      } catch (error) {
        // Verify we hit the default case
        expect(error).toBeInstanceOf(QueryParseError);
        expect((error as QueryParseError).message).toBe(
          'Unsupported node type: CompletelyUnknownType'
        );
      }
    });

    it('should handle invalid ParenthesizedExpression node', () => {
      // Testing line 142: the throw in the ParenthesizedExpression case
      // Create a direct mock of a ParenthesizedExpression without an expression property
      const mockNode = {
        type: 'ParenthesizedExpression'
        // Intentionally not adding an expression property
      };

      try {
        // Need to call the method directly
        (parser as unknown as QueryParserPrivate).convertLiqeAst(mockNode);
        fail('Should have thrown an error');
      } catch (error) {
        // Verify we hit the right case
        expect(error).toBeInstanceOf(QueryParseError);
        expect((error as QueryParseError).message).toBe(
          'Invalid parenthesized expression'
        );
      }
    });

    it('should handle multiple wildcards in a pattern', () => {
      const query = 'title:"*product*"';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'title',
        operator: 'LIKE',
        value: '*product*'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse prefix wildcard pattern (foo*)', () => {
      const query = 'name:foo*';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'LIKE',
        value: 'foo*'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse combined wildcard pattern (foo*bar)', () => {
      const query = 'name:foo*bar';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'LIKE',
        value: 'foo*bar'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse single character wildcard (foo?)', () => {
      const query = 'name:foo?';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'LIKE',
        value: 'foo?'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse combined single character wildcard (foo?bar)', () => {
      const query = 'name:foo?bar';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'LIKE',
        value: 'foo?bar'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    it('should parse mixed wildcard patterns (f*o?bar*)', () => {
      const query = 'name:f*o?bar*';
      const expected: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'LIKE',
        value: 'f*o?bar*'
      };

      expect(parser.parse(query)).toEqual(expected);
    });

    // IN operator syntax tests using consistent key:[values] pattern
    describe('IN operator syntax (key:[values])', () => {
      it('should parse "field:[val1, val2, val3]" bracket array syntax', () => {
        const query = 'status:[todo, doing, done]';
        const expected: QueryExpression = {
          type: 'logical',
          operator: 'OR',
          left: {
            type: 'logical',
            operator: 'OR',
            left: {
              type: 'comparison',
              field: 'status',
              operator: '==',
              value: 'todo'
            },
            right: {
              type: 'comparison',
              field: 'status',
              operator: '==',
              value: 'doing'
            }
          },
          right: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'done'
          }
        };

        expect(parser.parse(query)).toEqual(expected);
      });

      it('should parse numeric values in bracket syntax', () => {
        const query = 'id:[2, 3]';
        const expected: QueryExpression = {
          type: 'logical',
          operator: 'OR',
          left: {
            type: 'comparison',
            field: 'id',
            operator: '==',
            value: 2
          },
          right: {
            type: 'comparison',
            field: 'id',
            operator: '==',
            value: 3
          }
        };

        expect(parser.parse(query)).toEqual(expected);
      });

      it('should parse single value in bracket syntax', () => {
        const query = 'status:[active]';
        const expected: QueryExpression = {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'active'
        };

        expect(parser.parse(query)).toEqual(expected);
      });

      it('should preserve range syntax "field:[min TO max]"', () => {
        const query = 'id:[2 TO 5]';
        const expected: QueryExpression = {
          type: 'logical',
          operator: 'AND',
          left: {
            type: 'comparison',
            field: 'id',
            operator: '>=',
            value: 2
          },
          right: {
            type: 'comparison',
            field: 'id',
            operator: '<=',
            value: 5
          }
        };

        expect(parser.parse(query)).toEqual(expected);
      });

      it('should parse exclusive range syntax "field:{min TO max}"', () => {
        const query = 'id:{2 TO 5}';
        const expected: QueryExpression = {
          type: 'logical',
          operator: 'AND',
          left: {
            type: 'comparison',
            field: 'id',
            operator: '>',
            value: 2
          },
          right: {
            type: 'comparison',
            field: 'id',
            operator: '<',
            value: 5
          }
        };

        expect(parser.parse(query)).toEqual(expected);
      });

      it('should parse bracket syntax combined with other expressions', () => {
        const query = 'status:[todo, doing] AND priority:>2';
        const parsed = parser.parse(query);

        // Verify it's a logical AND at the top level
        expect(parsed.type).toBe('logical');
        expect((parsed as ILogicalExpression).operator).toBe('AND');

        // Left side should be OR of status values
        const left = (parsed as ILogicalExpression).left as ILogicalExpression;
        expect(left.type).toBe('logical');
        expect(left.operator).toBe('OR');
      });

      it('should handle values with spaces using quotes', () => {
        const query = 'name:[John, "Jane Doe"]';
        const parsed = parser.parse(query);

        expect(parsed.type).toBe('logical');
        expect((parsed as ILogicalExpression).operator).toBe('OR');

        const right = (parsed as ILogicalExpression)
          .right as IComparisonExpression;
        expect(right.value).toBe('Jane Doe');
      });

      it('should validate bracket syntax queries', () => {
        expect(parser.validate('status:[todo, doing, done]')).toBe(true);
        expect(parser.validate('id:[1, 2, 3]')).toBe(true);
        expect(parser.validate('id:[1 TO 10]')).toBe(true);
      });

      it('should handle mixed types in bracket syntax', () => {
        const query = 'priority:[1, 2, 3]';
        const parsed = parser.parse(query);

        expect(parsed.type).toBe('logical');
        // All values should be numbers
        const getLeftmost = (expr: QueryExpression): IComparisonExpression => {
          if (expr.type === 'comparison') return expr;
          return getLeftmost((expr as ILogicalExpression).left);
        };
        expect(typeof getLeftmost(parsed).value).toBe('number');
      });
    });
  });

  describe('validate', () => {
    it('should return true for valid queries', () => {
      const validQueries = [
        'priority:>2',
        'status:active',
        'priority:>2 AND status:active',
        'status:active OR status:pending',
        'NOT status:inactive'
      ];

      validQueries.forEach(query => {
        expect(parser.validate(query)).toBe(true);
      });
    });

    it('should return false for invalid queries', () => {
      const invalidQueries = ['', 'invalid:query:format', 'field:', ':value'];

      invalidQueries.forEach(query => {
        expect(parser.validate(query)).toBe(false);
      });
    });

    // New validation tests
    it('should return true for complex valid queries', () => {
      const validComplexQueries = [
        'name:"John Doe" AND (priority:>2 OR role:"admin")',
        '(status:active OR status:pending) AND NOT isDeleted:true',
        'tags:"important*" OR (priority:>3 AND assignee:"john@example.com")'
      ];

      validComplexQueries.forEach(query => {
        expect(parser.validate(query)).toBe(true);
      });
    });

    it('should return false for additional invalid queries', () => {
      const additionalInvalidQueries = [
        'field:value:extra', // Too many colons
        'AND field:value', // Starting with operator
        'field:value AND', // Ending with operator
        '(field:value', // Unclosed parenthesis
        'field:value)', // Extra closing parenthesis
        'OR' // Lone operator
      ];

      additionalInvalidQueries.forEach(query => {
        expect(parser.validate(query)).toBe(false);
      });
    });
  });

  // Test additional constructor options
  describe('parser options', () => {
    it('should apply default options when none provided', () => {
      const parser = new QueryParser();

      // Case sensitive by default
      const query = 'STATUS:active';
      const parsedQuery = parser.parse(query);
      expect(parsedQuery).toEqual({
        type: 'comparison',
        field: 'STATUS', // Not lowercased
        operator: '==',
        value: 'active'
      });
    });

    it('should apply multiple options when provided', () => {
      const parser = new QueryParser({
        caseInsensitiveFields: true,
        fieldMappings: { user_name: 'username' }
      });

      // Test both options working together
      const query = 'USER_NAME:john';
      const parsedQuery = parser.parse(query);
      expect(parsedQuery).toEqual({
        type: 'comparison',
        field: 'username', // Lowercased and mapped
        operator: '==',
        value: 'john'
      });
    });
  });

  // Add a specific test suite for direct private method testing
  describe('Private method testing for coverage', () => {
    let parser: QueryParser;

    beforeEach(() => {
      parser = new QueryParser();
    });

    it('should directly test convertLiqeOperator with various inputs', () => {
      // Testing convertLiqeOperator with various inputs for coverage
      // Access private method using type assertion
      const convertLiqeOperator = (
        parser as unknown as QueryParserPrivate
      ).convertLiqeOperator.bind(parser);

      // Test basic cases
      expect(convertLiqeOperator(':')).toBe('==');
      expect(convertLiqeOperator('=')).toBe('==');
      expect(convertLiqeOperator('!=')).toBe('!=');
      expect(convertLiqeOperator('>')).toBe('>');
      expect(convertLiqeOperator('>=')).toBe('>=');
      expect(convertLiqeOperator('<')).toBe('<');
      expect(convertLiqeOperator('<=')).toBe('<=');

      // Test specific cases for coverage
      expect(convertLiqeOperator('in')).toBe('IN');
      expect(convertLiqeOperator('not in')).toBe('NOT IN');

      // Test with colon prefix
      expect(convertLiqeOperator(':>')).toBe('>');

      // Test error case
      expect(() => convertLiqeOperator('unknown')).toThrow(QueryParseError);
    });

    it('should directly test convertLiqeValue with various inputs', () => {
      // Access private method using type assertion
      const convertLiqeValue = (
        parser as unknown as QueryParserPrivate
      ).convertLiqeValue.bind(parser);

      // Test various value types
      expect(convertLiqeValue('string')).toBe('string');
      expect(convertLiqeValue(123)).toBe(123);
      expect(convertLiqeValue(true)).toBe(true);
      expect(convertLiqeValue(null)).toBe(null);
      expect(convertLiqeValue([1, 2, 3])).toEqual([1, 2, 3]);

      // Test error case
      expect(() => convertLiqeValue({ key: 'value' })).toThrow(QueryParseError);
    });

    it('should directly test normalizeFieldName', () => {
      // Test with default options
      expect(
        (parser as unknown as QueryParserPrivate).normalizeFieldName(
          'fieldName'
        )
      ).toBe('fieldName');

      // Test with case insensitivity
      const caseInsensitiveParser = new QueryParser({
        caseInsensitiveFields: true
      });
      expect(
        (
          caseInsensitiveParser as unknown as QueryParserPrivate
        ).normalizeFieldName('FieldName')
      ).toBe('fieldname');

      // Test with field mappings
      const mappingParser = new QueryParser({
        fieldMappings: { old_name: 'newName' }
      });
      expect(
        (mappingParser as unknown as QueryParserPrivate).normalizeFieldName(
          'old_name'
        )
      ).toBe('newName');
      expect(
        (mappingParser as unknown as QueryParserPrivate).normalizeFieldName(
          'unmapped'
        )
      ).toBe('unmapped');

      // Test with both options
      const combinedParser = new QueryParser({
        caseInsensitiveFields: true,
        fieldMappings: { old_name: 'newName' }
      });
      expect(
        (combinedParser as unknown as QueryParserPrivate).normalizeFieldName(
          'OLD_NAME'
        )
      ).toBe('newName');
      expect(
        (combinedParser as unknown as QueryParserPrivate).normalizeFieldName(
          'Unmapped'
        )
      ).toBe('unmapped');
    });
  });
});
