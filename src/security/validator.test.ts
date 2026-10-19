import {
  QuerySecurityValidator,
  QuerySecurityError,
  aliasSecurityFields,
  applyEnforcedExclusions,
  assertAllowedFields,
  assertMaxValueLength,
  assertQueryComplexity,
  deniedNameForms,
  deniedNameSet,
  isAllowedName,
  isDeniedName,
  resolveMaxClauseCount,
  resolveMaxQueryDepth
} from './validator';
import { QueryParser } from '../parser/parser';
import {
  QueryExpression,
  IComparisonExpression,
  ILogicalExpression
} from '../parser/types';
import { DEFAULT_SECURITY_OPTIONS, ISecurityOptions } from './types';

/**
 * Build `label:1 AND label:1 AND ...` as a left-leaning chain of `count`
 * comparisons. The validator counts one depth level per logical node, so a
 * chain of `n` comparisons has depth `n - 1`.
 */
function buildComparisonChain(count: number): QueryExpression {
  const comparison = (): IComparisonExpression => ({
    type: 'comparison',
    field: 'label',
    operator: '==',
    value: 1
  });
  let expression: QueryExpression = comparison();
  for (let i = 1; i < count; i += 1) {
    expression = {
      type: 'logical',
      operator: 'AND',
      left: expression,
      right: comparison()
    };
  }
  return expression;
}

/**
 * Build a balanced AND tree of `count` comparisons, so the clause count grows
 * while the depth stays at `ceil(log2(count))`.
 */
function buildBalancedTree(count: number): QueryExpression {
  if (count <= 1) {
    return { type: 'comparison', field: 'label', operator: '==', value: 1 };
  }
  const half = Math.floor(count / 2);
  return {
    type: 'logical',
    operator: 'AND',
    left: buildBalancedTree(half),
    right: buildBalancedTree(count - half)
  };
}

/** A membership list of `count` distinct numbers. */
function buildMembership(count: number): IComparisonExpression {
  return {
    type: 'comparison',
    field: 'label',
    operator: 'IN',
    value: Array.from({ length: count }, (_, index) => index + 1)
  };
}

describe('QuerySecurityValidator', () => {
  let validator: QuerySecurityValidator;
  let parser: QueryParser;

  beforeEach(() => {
    parser = new QueryParser();
    validator = new QuerySecurityValidator();
  });

  describe('constructor', () => {
    it('should use default options when none provided', () => {
      const validator = new QuerySecurityValidator();
      expect(validator).toBeDefined();
    });

    it('should override default options with provided options', () => {
      const validator = new QuerySecurityValidator({
        maxQueryDepth: 3,
        maxClauseCount: 5
      });
      expect(validator).toBeDefined();
    });
  });

  describe('validate', () => {
    it('should not throw error for valid query', () => {
      const query = parser.parse('name:"John" AND priority:>18');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should validate against a provided schema', () => {
      const query = parser.parse('user.name:"John" AND user.priority:>18');
      const schema = {
        user: {
          name: 'string',
          priority: 'number'
        }
      };
      expect(() => validator.validate(query, schema)).not.toThrow();
    });

    it('should validate field types correctly', () => {
      const query = parser.parse('name:"John" AND priority:>2');
      const schema = {
        user: {
          name: 'string',
          priority: 'number'
        }
      };

      // Should pass validation with correct schema
      expect(() => validator.validate(query, schema)).not.toThrow();
    });

    it('should validate complex field paths', () => {
      const query = parser.parse('user.name:"John" AND user.priority:>2');
      const schema = {
        user: {
          name: 'string',
          priority: 'number'
        }
      };

      // Should pass validation with correct schema
      expect(() => validator.validate(query, schema)).not.toThrow();
    });

    it('should validate allowed fields correctly', () => {
      const query = parser.parse('name:"John" AND priority:>2');
      const validatorWithAllowedFields = new QuerySecurityValidator({
        allowedFields: ['name', 'priority', 'status']
      });

      // Should not throw when all fields are allowed
      expect(() => validatorWithAllowedFields.validate(query)).not.toThrow();
    });

    it('should validate query depth correctly', () => {
      const query = parser.parse(
        '(name:"John" AND priority:>2) AND (role:"admin" OR status:"active")'
      );
      const validatorWithDepthLimit = new QuerySecurityValidator({
        maxQueryDepth: 3
      });

      // Should not throw when query depth is within limits
      expect(() => validatorWithDepthLimit.validate(query)).not.toThrow();
    });

    it('should validate clause count correctly', () => {
      const query = parser.parse(
        'name:"John" AND priority:>2 AND role:"admin" AND status:"active"'
      );
      const validatorWithClauseLimit = new QuerySecurityValidator({
        maxClauseCount: 4
      });

      // Should not throw when clause count is within limits
      expect(() => validatorWithClauseLimit.validate(query)).not.toThrow();
    });

    it('should reject queries exceeding clause limit', () => {
      const query = parser.parse(
        'name:"John" AND priority:>2 AND role:"admin" AND status:"active"'
      );
      const validatorWithLowerClauseLimit = new QuerySecurityValidator({
        maxClauseCount: 3
      });

      // Should throw when clause count exceeds limit
      expect(() => validatorWithLowerClauseLimit.validate(query)).toThrow(
        QuerySecurityError
      );
    });
  });

  describe('validateFields', () => {
    it('should allow fields from schema', () => {
      const query = parser.parse('user.name:"John"');
      const schema = {
        user: {
          name: 'string',
          priority: 'number'
        }
      };
      expect(() => validator.validate(query, schema)).not.toThrow();
    });

    it('should allow fields in allowedFields list', () => {
      const validator = new QuerySecurityValidator({
        allowedFields: ['name', 'priority']
      });
      const query = parser.parse('name:"John" AND priority:>18');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should reject fields not in allowedFields list', () => {
      const validator = new QuerySecurityValidator({
        allowedFields: ['name']
      });
      const query = parser.parse('name:"John" AND priority:>18');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should reject fields in denyFields list', () => {
      const validator = new QuerySecurityValidator({
        denyFields: ['password', 'secretKey']
      });
      const query = parser.parse('username:"admin" AND password:"secret"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should reject fields in denyFields even if in allowedFields', () => {
      const validator = new QuerySecurityValidator({
        allowedFields: ['username', 'password'],
        denyFields: ['password']
      });
      const query = parser.parse('username:"admin" AND password:"secret"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        'Invalid query parameters'
      );
    });
  });

  describe('validateQueryDepth', () => {
    it('should accept queries within depth limit', () => {
      const validator = new QuerySecurityValidator({
        maxQueryDepth: 3
      });
      // Depth = 3: (a && b) && (c || d)
      const query = parser.parse(
        '(name:"John" AND priority:>18) AND (role:"admin" OR status:"active")'
      );
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should reject queries exceeding depth limit', () => {
      // Create a mock query with excessive depth
      const deepQuery: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'logical',
          operator: 'AND',
          left: {
            type: 'logical',
            operator: 'AND',
            left: {
              type: 'comparison',
              field: 'level1',
              operator: '==',
              value: 'value1'
            },
            right: {
              type: 'comparison',
              field: 'level2',
              operator: '==',
              value: 'value2'
            }
          },
          right: {
            type: 'comparison',
            field: 'level3',
            operator: '==',
            value: 'value3'
          }
        },
        right: {
          type: 'comparison',
          field: 'level4',
          operator: '==',
          value: 'value4'
        }
      };

      const testValidator = new QuerySecurityValidator({
        maxQueryDepth: 2
      });

      expect(() => testValidator.validate(deepQuery)).toThrow(
        QuerySecurityError
      );
      expect(() => testValidator.validate(deepQuery)).toThrow(
        'Query exceeds maximum depth of 2'
      );
    });
  });

  describe('validateClauseCount', () => {
    it('should accept queries within clause count limit', () => {
      const validator = new QuerySecurityValidator({
        maxClauseCount: 4
      });
      // 4 clauses: a, b, c, d
      const query = parser.parse(
        'name:"John" AND priority:>18 AND role:"admin" AND status:"active"'
      );
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should reject queries exceeding clause count limit', () => {
      const validator = new QuerySecurityValidator({
        maxClauseCount: 3
      });
      // 4 clauses: a, b, c, d
      const query = parser.parse(
        'name:"John" AND priority:>18 AND role:"admin" AND status:"active"'
      );
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        /Query exceeds maximum clause count of 3/
      );
    });
  });

  describe('validateValueLengths', () => {
    it('should accept string values within length limit', () => {
      const validator = new QuerySecurityValidator({
        maxValueLength: 10
      });
      const query = parser.parse('name:"John"');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should reject string values exceeding length limit', () => {
      const validator = new QuerySecurityValidator({
        maxValueLength: 5
      });
      const query = parser.parse('name:"JohnDoe"'); // Length = 7
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        /exceeds maximum length of 5 characters/
      );
    });

    it('should reject string array values exceeding length limit', () => {
      const validator = new QuerySecurityValidator({
        maxValueLength: 5
      });

      // Create a mock expression with an array containing a long string
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'name',
        operator: 'IN',
        value: ['John', 'VeryLongName'] // Second value exceeds maxValueLength
      };

      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
      expect(() => validator.validate(mockQuery)).toThrow(
        /exceeds maximum length of 5 characters/
      );
    });
  });

  describe('sanitizeWildcards', () => {
    it('should sanitize excessive wildcards in LIKE queries', () => {
      const validator = new QuerySecurityValidator({
        sanitizeWildcards: true
      });
      const expression = parser.parse('name:"a*****b"') as QueryExpression;
      validator.validate(expression);

      // Expectation: expression has been modified to sanitize wildcards
      // Since this is modifying the expression in-place, we use a type assertion
      const comparisonExpr = expression as IComparisonExpression;
      expect(comparisonExpr.value).toBe('a*b');
    });

    it('should not sanitize wildcards when the option is disabled', () => {
      const validator = new QuerySecurityValidator({
        sanitizeWildcards: false
      });
      const expression = parser.parse('name:"a*****b"') as QueryExpression;
      validator.validate(expression);

      // Expectation: expression has not been modified
      const comparisonExpr = expression as IComparisonExpression;
      expect(comparisonExpr.value).toBe('a*****b');
    });
  });

  describe('validateDenyValues', () => {
    it('should accept queries when no denyValues are configured', () => {
      const validator = new QuerySecurityValidator({});
      const query = parser.parse('status:"deleted"');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should accept queries when value is not in denyValues list', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          status: ['deleted', 'banned']
        }
      });
      const query = parser.parse('status:"active"');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should reject queries with denied string values', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          status: ['deleted', 'banned']
        }
      });
      const query = parser.parse('status:"deleted"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should reject queries with denied numeric values', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          priority: [0, -1]
        }
      });
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'priority',
        operator: '==',
        value: 0
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
      expect(() => validator.validate(mockQuery)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should reject queries with denied boolean values', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          isAdmin: [true]
        }
      });
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'isAdmin',
        operator: '==',
        value: true
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
      expect(() => validator.validate(mockQuery)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should reject queries with denied null values', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          deletedAt: [null]
        }
      });
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'deletedAt',
        operator: '==',
        value: null
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
      expect(() => validator.validate(mockQuery)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should reject queries with denied values in IN operator arrays', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          role: ['superadmin', 'system']
        }
      });
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'role',
        operator: 'IN',
        value: ['admin', 'superadmin'] // Contains 'superadmin' which is denied
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
      expect(() => validator.validate(mockQuery)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should accept IN operator arrays without denied values', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          role: ['superadmin', 'system']
        }
      });
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'role',
        operator: 'IN',
        value: ['admin', 'user', 'moderator']
      };
      expect(() => validator.validate(mockQuery)).not.toThrow();
    });

    it('should validate denied values in nested logical expressions', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          status: ['deleted']
        }
      });
      const query = parser.parse('name:"John" AND status:"deleted"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should validate denied values in complex nested expressions', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          role: ['superadmin']
        }
      });
      const query = parser.parse(
        '(name:"John" OR name:"Jane") AND (role:"superadmin" OR status:"active")'
      );
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should support dot-notation field names in denyValues', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          'user.role': ['superadmin', 'system']
        }
      });
      const query = parser.parse('user.role:"superadmin"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        'Invalid query parameters'
      );
    });

    it('should allow same value for different fields when only one is denied', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          role: ['admin']
        }
      });
      // Query for 'type' field with value 'admin' should pass since only 'role' field denies 'admin'
      const query = parser.parse('type:"admin"');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should handle multiple fields with denyValues', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          status: ['deleted', 'banned'],
          role: ['superadmin'],
          priority: [0]
        }
      });

      // Should reject when any denied value is used
      const query1 = parser.parse('status:"active" AND role:"superadmin"');
      expect(() => validator.validate(query1)).toThrow(QuerySecurityError);

      // Should accept when all values are allowed
      const query2 = parser.parse('status:"active" AND role:"admin"');
      expect(() => validator.validate(query2)).not.toThrow();
    });

    it('should work in combination with denyFields', () => {
      const validator = new QuerySecurityValidator({
        denyFields: ['password'],
        denyValues: {
          status: ['deleted']
        }
      });

      // Should reject due to denyFields
      const query1 = parser.parse('password:"secret"');
      expect(() => validator.validate(query1)).toThrow(QuerySecurityError);

      // Should reject due to denyValues
      const query2 = parser.parse('status:"deleted"');
      expect(() => validator.validate(query2)).toThrow(QuerySecurityError);

      // Should accept when both are satisfied
      const query3 = parser.parse('status:"active" AND username:"john"');
      expect(() => validator.validate(query3)).not.toThrow();
    });

    it('should work in combination with allowedFields', () => {
      const validator = new QuerySecurityValidator({
        allowedFields: ['status', 'name'],
        denyValues: {
          status: ['deleted']
        }
      });

      // Should reject due to denyValues
      const query1 = parser.parse('status:"deleted"');
      expect(() => validator.validate(query1)).toThrow(QuerySecurityError);

      // Should accept when value is allowed
      const query2 = parser.parse('status:"active" AND name:"John"');
      expect(() => validator.validate(query2)).not.toThrow();
    });

    it('should handle string-number type coercion for denied values', () => {
      const validator = new QuerySecurityValidator({
        denyValues: {
          code: [123, 456]
        }
      });
      // Query with string "123" should match numeric 123 in denyValues
      const query = parser.parse('code:"123"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
    });
  });

  describe('validateDenyValues with negation operators', () => {
    // denyValues blocks ALL mentions of denied values, regardless of operator.
    // This is intentional: the user should not be able to even reference a denied
    // value in their query. Use enforceExcludedValues for server-side RBAC.

    it('should block NOT operator wrapping a denied value', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['archived', 'deleted'] }
      });
      const query = parser.parse('NOT status:"archived"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
    });

    it('should block != operator with a denied value', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['deleted'] }
      });
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: '!=',
        value: 'deleted'
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
    });

    it('should block NOT IN operator with denied values', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['archived', 'deleted'] }
      });
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: 'NOT IN',
        value: ['archived', 'deleted']
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
    });

    it('should block positive matches with denied values', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['archived'] }
      });
      const query = parser.parse('status:"archived"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
    });

    it('should block IN operator that includes a denied value', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['archived', 'deleted'] }
      });
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: 'IN',
        value: ['archived', 'active']
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
    });

    it('should block double-negated denied values (NOT NOT)', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['deleted'] }
      });
      const mockQuery: QueryExpression = {
        type: 'logical',
        operator: 'NOT',
        left: {
          type: 'logical',
          operator: 'NOT',
          left: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'deleted'
          }
        }
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
    });

    it('should block triple-negated denied values (NOT NOT NOT)', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['deleted'] }
      });
      const mockQuery: QueryExpression = {
        type: 'logical',
        operator: 'NOT',
        left: {
          type: 'logical',
          operator: 'NOT',
          left: {
            type: 'logical',
            operator: 'NOT',
            left: {
              type: 'comparison',
              field: 'status',
              operator: '==',
              value: 'deleted'
            }
          }
        }
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
    });

    it('should block denied value in AND expression even when other branch is safe', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['deleted'] }
      });
      // name:"John" AND NOT status:"deleted" — the denied value is still mentioned
      const mockQuery: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'comparison',
          field: 'name',
          operator: '==',
          value: 'John'
        },
        right: {
          type: 'logical',
          operator: 'NOT',
          left: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'deleted'
          }
        }
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
    });

    it('should block denied value in OR expression even when other branch is safe', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['deleted'] }
      });
      // NOT status:"deleted" OR name:"John" — still mentions denied value
      const mockQuery: QueryExpression = {
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'logical',
          operator: 'NOT',
          left: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'deleted'
          }
        },
        right: {
          type: 'comparison',
          field: 'name',
          operator: '==',
          value: 'John'
        }
      };
      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
    });

    it('should not affect queries that do not reference denied values', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['deleted'] }
      });
      // NOT name:"John" is fine — name is not in denyValues
      const query = parser.parse('NOT name:"John"');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should allow queries on fields not listed in denyValues', () => {
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['deleted'] }
      });
      const query = parser.parse('name:"active"');
      expect(() => validator.validate(query)).not.toThrow();
    });
  });

  describe('validateNoDotNotation (allowDotNotation)', () => {
    it('should allow dot notation by default', () => {
      const validator = new QuerySecurityValidator({});
      const query = parser.parse('user.name:"John"');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should allow dot notation when explicitly enabled', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: true
      });
      const query = parser.parse('user.name:"John" AND user.role:"admin"');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should reject dot notation when disabled', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      const query = parser.parse('user.name:"John"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        'Dot notation is not allowed in field names'
      );
    });

    it('should include the field name in error message', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      const query = parser.parse('metadata.secret:"value"');
      expect(() => validator.validate(query)).toThrow('metadata.secret');
    });

    it('should suggest using simple field names in error message', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      const query = parser.parse('user.email:"test@example.com"');
      expect(() => validator.validate(query)).toThrow(
        'use a simple field name without dots'
      );
    });

    it('should allow simple field names when dot notation is disabled', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      const query = parser.parse('name:"John" AND email:"john@example.com"');
      expect(() => validator.validate(query)).not.toThrow();
    });

    it('should reject deeply nested dot notation', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      const query = parser.parse('user.profile.settings.theme:"dark"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow(
        'user.profile.settings.theme'
      );
    });

    it('should validate dot notation in nested logical expressions', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      const query = parser.parse('name:"John" AND user.role:"admin"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow('user.role');
    });

    it('should validate dot notation in complex nested expressions', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      const query = parser.parse(
        '(name:"John" OR name:"Jane") AND (status:"active" OR user.type:"premium")'
      );
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow('user.type');
    });

    it('should validate dot notation in OR branches', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      const query = parser.parse('name:"John" OR metadata.tags:"vip"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
    });

    it('should work with other security options when dot notation is disabled', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false,
        allowedFields: ['name', 'email', 'status'],
        maxQueryDepth: 3
      });

      // Should pass - simple fields, within depth
      const validQuery = parser.parse('name:"John" AND status:"active"');
      expect(() => validator.validate(validQuery)).not.toThrow();

      // Should fail - dot notation
      const dotQuery = parser.parse('user.name:"John"');
      expect(() => validator.validate(dotQuery)).toThrow(
        'Dot notation is not allowed'
      );
    });

    it('should reject table-qualified column access when disabled', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      // Simulating attempt to access another table's column
      const query = parser.parse('users.password:"secret"');
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
      expect(() => validator.validate(query)).toThrow('users.password');
    });

    it('should reject JSON path access when disabled', () => {
      const validator = new QuerySecurityValidator({
        allowDotNotation: false
      });
      // Simulating attempt to access JSON/JSONB nested field
      const query = parser.parse(
        'config.database.connectionString:"postgres://"'
      );
      expect(() => validator.validate(query)).toThrow(QuerySecurityError);
    });
  });

  describe('SQL Injection Prevention', () => {
    // Testing protection against common SQL injection patterns

    // Union-based injection tests
    it('should protect against UNION-based SQL injection', () => {
      const validator = new QuerySecurityValidator({
        allowedFields: ['username'], // Restrict to just username field
        maxValueLength: 100 // Allow long enough for the test
      });

      // Create a mock query that would be a UNION-based injection if executed
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'malicious_field', // This field isn't in allowedFields
        operator: '==',
        value: "admin' UNION SELECT username,password,NULL FROM users;--"
      };

      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
      expect(() => validator.validate(mockQuery)).toThrow(
        'Invalid query parameters'
      );
    });

    // Error-based injection test
    it('should protect against error-based SQL injection', () => {
      const validator = new QuerySecurityValidator({
        allowedFields: ['id'], // Restrict fields
        maxValueLength: 100
      });

      // Create a mock query that would be an error-based injection
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'malicious_field', // Not in allowedFields
        operator: '==',
        value:
          "1' OR (SELECT CASE WHEN (username='admin' AND SUBSTRING(password,1,1)='a') THEN 1/0 ELSE 'a' END FROM users WHERE id=1)--"
      };

      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
    });

    // Boolean-based injection test
    it('should protect against boolean-based SQL injection attempts', () => {
      const validator = new QuerySecurityValidator({
        maxValueLength: 20 // Set a lower limit for test
      });

      // Create a mock query with a long value that would exceed maxValueLength
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'username',
        operator: '==',
        value:
          "admin' AND (SELECT 1 FROM users WHERE username='admin' AND password LIKE 'a%')=1--"
      };

      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
      expect(() => validator.validate(mockQuery)).toThrow(
        /exceeds maximum length of 20 characters/
      );
    });

    // Time-based injection test
    it('should protect against time-based SQL injection attempts', () => {
      const validator = new QuerySecurityValidator({
        maxValueLength: 30 // Set a reasonable limit
      });

      // Create a mock query with a long value that would exceed maxValueLength
      const mockQuery: QueryExpression = {
        type: 'comparison',
        field: 'username',
        operator: '==',
        value:
          "admin' AND IF((SELECT password FROM users WHERE username='admin')='password', SLEEP(5), 0)--"
      };

      expect(() => validator.validate(mockQuery)).toThrow(QuerySecurityError);
      expect(() => validator.validate(mockQuery)).toThrow(
        /exceeds maximum length of 30 characters/
      );
    });

    // Testing against dangerous characters in input
    it('should protect against dangerous SQL characters', () => {
      const validator = new QuerySecurityValidator({
        maxValueLength: 20 // Reduced to ensure at least some values exceed it
      });

      // We'll test each pattern individually to identify which ones work
      const dangerousValues = [
        "admin'; DROP TABLE users;--", // 25 chars
        "admin' OR '1'='1; DELETE FROM users", // 35 chars
        "admin' --",
        'admin/**/OR/**/1=1',
        "admin' WAITFOR DELAY '0:0:5'--" // 31 chars
      ];

      // Test each value individually (at least one should fail)
      let atLeastOneFailed = false;

      dangerousValues.forEach(value => {
        // Create a vulnerable mock query
        const mockQuery: QueryExpression = {
          type: 'comparison',
          field: 'username', // Use a valid field to focus on value validation
          operator: '==',
          value
        };

        try {
          validator.validate(mockQuery);
        } catch (error) {
          if (error instanceof QuerySecurityError) {
            atLeastOneFailed = true;
          }
        }
      });

      // Ensure at least one pattern triggered security validation
      expect(atLeastOneFailed).toBe(true);
    });
  });

  describe('enforceExcludedValues option in DEFAULT_SECURITY_OPTIONS', () => {
    it('should have enforceExcludedValues as an empty object by default', () => {
      expect(DEFAULT_SECURITY_OPTIONS.enforceExcludedValues).toBeDefined();
      expect(DEFAULT_SECURITY_OPTIONS.enforceExcludedValues).toEqual({});
    });

    it('should accept enforceExcludedValues in constructor options', () => {
      expect(() => {
        new QuerySecurityValidator({
          enforceExcludedValues: {
            status: ['archived', 'deleted']
          }
        });
      }).not.toThrow();
    });
  });

  describe('inherited property names', () => {
    it('does not treat inherited deny lists as value denials', () => {
      const subject = new QuerySecurityValidator({
        denyValues: { status: ['deleted'] }
      });
      const inheritedName: IComparisonExpression = {
        type: 'comparison',
        field: 'constructor',
        operator: '==',
        value: 'active'
      };
      expect(() => subject.validate(inheritedName)).not.toThrow();
      const denied: IComparisonExpression = {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'deleted'
      };
      expect(() => subject.validate(denied)).toThrow(QuerySecurityError);
    });
  });

  // Shared checks the translators and adapters call before they build SQL or
  // walk rows. The engine-parity tests named by docs/bugs/max-value-length.md,
  // array-cap.md, depth-clause.md, allowlist.md and excluded-fields.md land
  // with the engines; these pin the helpers at the validator.
  describe('assertMaxValueLength', () => {
    const equality = (length: number): IComparisonExpression => ({
      type: 'comparison',
      field: 'label',
      operator: '==',
      value: 'a'.repeat(length)
    });
    const membership = (length: number): IComparisonExpression => ({
      type: 'comparison',
      field: 'label',
      operator: 'IN',
      value: ['a'.repeat(length)]
    });

    it('accepts a 1000-character string by default', () => {
      expect(() => assertMaxValueLength(equality(1000))).not.toThrow();
      expect(() => assertMaxValueLength(membership(1000))).not.toThrow();
    });

    it('rejects a 1001-character string with the validator wording', () => {
      expect(() => assertMaxValueLength(equality(1001))).toThrow(
        QuerySecurityError
      );
      expect(() => assertMaxValueLength(equality(1001))).toThrow(
        'Query contains a string value that exceeds maximum length of 1000 characters'
      );
    });

    it('rejects a 1001-character membership member with the array wording', () => {
      expect(() => assertMaxValueLength(membership(1001))).toThrow(
        'Query contains a string value in array that exceeds maximum length of 1000 characters'
      );
    });

    it('accepts a 1001-character string when the cap is raised', () => {
      expect(() => assertMaxValueLength(equality(1001), 1001)).not.toThrow();
      expect(() => assertMaxValueLength(membership(1001), 1001)).not.toThrow();
    });

    it('checks every comparison inside a logical expression', () => {
      const expression: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: equality(1),
        right: { type: 'logical', operator: 'NOT', left: equality(1001) }
      };
      expect(() => assertMaxValueLength(expression)).toThrow(
        QuerySecurityError
      );
    });

    it('ignores a missing node so callers keep their own errors', () => {
      expect(() => assertMaxValueLength(null)).not.toThrow();
      expect(() => assertMaxValueLength(undefined)).not.toThrow();
      const missingLeft = {
        type: 'logical',
        operator: 'AND',
        left: undefined
      } as unknown as ILogicalExpression;
      expect(() => assertMaxValueLength(missingLeft)).not.toThrow();
    });

    it('still rejects through validate with a raised cap', () => {
      const subject = new QuerySecurityValidator({ maxValueLength: 1001 });
      expect(() => subject.validate(equality(1001))).not.toThrow();
      expect(() => subject.validate(equality(1002))).toThrow(
        /exceeds maximum length of 1001 characters/
      );
    });
  });

  describe('array item cap', () => {
    it('accepts a 100-item list and rejects a 101-item list', () => {
      expect(() => assertMaxValueLength(buildMembership(100))).not.toThrow();
      expect(() => assertMaxValueLength(buildMembership(101))).toThrow(
        'Array values cannot exceed 100 items'
      );
      expect(() => validator.validate(buildMembership(101))).toThrow(
        'Array values cannot exceed 100 items'
      );
    });

    it('rejects a long list before a long string inside it', () => {
      const list = buildMembership(101);
      list.value = [...(list.value as number[]), 'a'.repeat(1001)].slice(1);
      expect(() => assertMaxValueLength(list)).toThrow(
        'Array values cannot exceed 100 items'
      );
    });

    it('keeps the cap when maxValueLength is raised', () => {
      expect(() => assertMaxValueLength(buildMembership(101), 5000)).toThrow(
        'Array values cannot exceed 100 items'
      );
    });
  });

  describe('assertQueryComplexity', () => {
    it('resolves the default caps', () => {
      expect(resolveMaxQueryDepth(undefined)).toBe(10);
      expect(resolveMaxQueryDepth(11)).toBe(11);
      expect(resolveMaxClauseCount(undefined)).toBe(50);
      expect(resolveMaxClauseCount(51)).toBe(51);
    });

    it('accepts a chain at the depth cap and rejects one step past it', () => {
      expect(() =>
        assertQueryComplexity(buildComparisonChain(11))
      ).not.toThrow();
      expect(() => assertQueryComplexity(buildComparisonChain(12))).toThrow(
        'Query exceeds maximum depth of 10'
      );
      expect(() => validator.validate(buildComparisonChain(12))).toThrow(
        'Query exceeds maximum depth of 10'
      );
    });

    it('accepts a tree at the clause cap and rejects one step past it', () => {
      expect(() => assertQueryComplexity(buildBalancedTree(50))).not.toThrow();
      expect(() => assertQueryComplexity(buildBalancedTree(51))).toThrow(
        'Query exceeds maximum clause count of 50 (found 51)'
      );
      expect(() => validator.validate(buildBalancedTree(51))).toThrow(
        'Query exceeds maximum clause count of 50 (found 51)'
      );
    });

    it('accepts one step past each default when the cap is raised', () => {
      expect(() =>
        assertQueryComplexity(buildComparisonChain(12), 11, 50)
      ).not.toThrow();
      expect(() =>
        assertQueryComplexity(buildBalancedTree(51), 10, 51)
      ).not.toThrow();
    });

    it('ignores a missing node', () => {
      expect(() => assertQueryComplexity(null)).not.toThrow();
      expect(() => assertQueryComplexity(undefined)).not.toThrow();
    });
  });

  describe('assertAllowedFields', () => {
    it('allows every field when the list is omitted or empty', () => {
      const query = parser.parse('secret:1');
      expect(() => assertAllowedFields(query)).not.toThrow();
      expect(() => assertAllowedFields(query, [])).not.toThrow();
    });

    it('rejects a field outside a non-empty list before any row is read', () => {
      expect(() =>
        assertAllowedFields(parser.parse('status:open'), ['status'])
      ).not.toThrow();
      expect(() =>
        assertAllowedFields(parser.parse('secret:1'), ['status'])
      ).toThrow(QuerySecurityError);
      expect(() =>
        assertAllowedFields(parser.parse('status:open OR secret:1'), ['status'])
      ).toThrow('Invalid query parameters');
    });

    it('compares a dotted name as the whole field string', () => {
      expect(() =>
        assertAllowedFields(parser.parse('owner.city:Austin'), ['city'])
      ).toThrow(QuerySecurityError);
      expect(() =>
        assertAllowedFields(parser.parse('owner.city:Austin'), ['owner.city'])
      ).not.toThrow();
    });

    it('ignores a missing node', () => {
      expect(() => assertAllowedFields(null, ['status'])).not.toThrow();
    });

    it('matches the list as written, ignoring neither case nor a qualifier', () => {
      const allowed = new Set(['status']);
      expect(isAllowedName('status', allowed)).toBe(true);
      expect(isAllowedName('STATUS', allowed)).toBe(false);
      expect(isAllowedName('items.status', allowed)).toBe(false);
    });
  });

  describe('applyEnforcedExclusions', () => {
    const query = (): QueryExpression => parser.parse('status:open');

    it('returns the expression as given for an omitted, empty, or emptied map', () => {
      const expression = query();
      expect(applyEnforcedExclusions(expression)).toBe(expression);
      expect(applyEnforcedExclusions(expression, {})).toBe(expression);
      expect(applyEnforcedExclusions(expression, { secret: [] })).toBe(
        expression
      );
    });

    it('ANDs a NOT IN comparison for each field with values', () => {
      const expression = query();
      expect(applyEnforcedExclusions(expression, { secret: [1] })).toEqual({
        type: 'logical',
        operator: 'AND',
        left: expression,
        right: {
          type: 'comparison',
          field: 'secret',
          operator: 'NOT IN',
          value: [1]
        }
      });
      const twice = applyEnforcedExclusions(expression, {
        secret: [1],
        visibility: ['internal']
      }) as ILogicalExpression;
      expect(twice.operator).toBe('AND');
      expect((twice.right as IComparisonExpression).field).toBe('visibility');
      expect(
        ((twice.left as ILogicalExpression).right as IComparisonExpression)
          .field
      ).toBe('secret');
    });

    it('reads own keys only', () => {
      const expression = query();
      const inherited = Object.create({ secret: [1] }) as Record<
        string,
        Array<string | number | boolean | null>
      >;
      expect(applyEnforcedExclusions(expression, inherited)).toBe(expression);
    });
  });

  // docs/bugs/denylist-bypass.md: a deny-list entry matches a field regardless
  // of ASCII case and of a single `table.` qualifier on either side.
  describe('denied name forms', () => {
    it('folds ASCII case and strips a single table qualifier', () => {
      expect(deniedNameForms('Items.Secret')).toEqual([
        'items.secret',
        'secret'
      ]);
      expect(deniedNameForms('SECRET')).toEqual(['secret']);
      expect(deniedNameForms('a.b.secret')).toEqual(['a.b.secret']);
      expect(deniedNameForms('column.')).toEqual(['column.']);
      expect(deniedNameForms('.column')).toEqual(['.column']);
      expect(deniedNameForms('Σ')).toEqual(['Σ']);
    });

    it('unions the forms of every entry', () => {
      expect(deniedNameSet(['SECRET', 'items.Token'])).toEqual(
        new Set(['secret', 'items.token', 'token'])
      );
    });

    it('matches a field by any of its forms', () => {
      const denied = deniedNameSet(['secret']);
      expect(isDeniedName('secret', denied)).toBe(true);
      expect(isDeniedName('SECRET', denied)).toBe(true);
      expect(isDeniedName('items.secret', denied)).toBe(true);
      expect(isDeniedName('Items.secret', denied)).toBe(true);
      expect(isDeniedName('status', denied)).toBe(false);
      expect(isDeniedName('a.b.secret', denied)).toBe(false);
    });

    it.each([
      ['secret', 'items.secret:a'],
      ['secret', 'SECRET:a'],
      ['secret', 'Items.secret:a'],
      ['secret', '"items.secret":a'],
      ['SECRET', 'secret:a'],
      ['items.secret', 'secret:a'],
      ['secret', 'status:open AND secret:a']
    ])('denyFields %p rejects %s', (entry, query) => {
      const subject = new QuerySecurityValidator({ denyFields: [entry] });
      expect(() => subject.validate(parser.parse(query))).toThrow(
        'Invalid query parameters'
      );
    });

    it('keeps a permitted field and a two-dot name as written', () => {
      const subject = new QuerySecurityValidator({ denyFields: ['secret'] });
      expect(() => subject.validate(parser.parse('status:open'))).not.toThrow();
      expect(() =>
        subject.validate(parser.parse('a.b.secret:a'))
      ).not.toThrow();
    });

    it('leaves the allowlist matching as written', () => {
      const subject = new QuerySecurityValidator({ allowedFields: ['status'] });
      expect(() => subject.validate(parser.parse('STATUS:open'))).toThrow(
        QuerySecurityError
      );
      expect(() => subject.validate(parser.parse('items.status:open'))).toThrow(
        QuerySecurityError
      );
    });
  });

  // docs/bugs/aliased-deny.md and aliased-deny-values.md: a fieldMappings
  // alias and its target are one field for the lists, the value map, and the
  // exclusion map.
  describe('aliasSecurityFields', () => {
    const resolve = (
      options: ISecurityOptions,
      fieldMappings?: Record<string, string>,
      foldsCase = false
    ): Required<ISecurityOptions> =>
      aliasSecurityFields(
        { ...DEFAULT_SECURITY_OPTIONS, ...options },
        fieldMappings,
        foldsCase
      );
    const alias = { hidden: 'secret' };

    it('returns the options as given without a map', () => {
      const options = { ...DEFAULT_SECURITY_OPTIONS, denyFields: ['hidden'] };
      expect(aliasSecurityFields(options, undefined, false)).toBe(options);
      expect(aliasSecurityFields(options, {}, false)).toBe(options);
    });

    it('joins the target of a listed alias and the alias of a listed target', () => {
      expect(resolve({ denyFields: ['hidden'] }, alias).denyFields).toEqual([
        'hidden',
        'secret'
      ]);
      expect(resolve({ denyFields: ['secret'] }, alias).denyFields).toEqual([
        'secret',
        'hidden'
      ]);
      expect(
        resolve({ allowedFields: ['status', 'hidden'] }, alias).allowedFields
      ).toEqual(['status', 'hidden', 'secret']);
      expect(
        resolve({ allowedFields: ['status', 'secret'] }, alias).allowedFields
      ).toEqual(['status', 'secret', 'hidden']);
    });

    it('matches a deny entry by its denied forms and an allow entry as written', () => {
      expect(resolve({ denyFields: ['HIDDEN'] }, alias).denyFields).toContain(
        'secret'
      );
      expect(
        resolve({ denyFields: ['items.hidden'] }, alias).denyFields
      ).toContain('secret');
      expect(
        resolve({ allowedFields: ['status', 'HIDDEN'] }, alias).allowedFields
      ).toEqual(['status', 'HIDDEN']);
      expect(
        resolve({ allowedFields: ['status', 'items.hidden'] }, alias)
          .allowedFields
      ).toEqual(['status', 'items.hidden']);
    });

    it('folds an allow entry under caseInsensitiveFields', () => {
      expect(
        resolve({ allowedFields: ['status', 'HIDDEN'] }, alias, true)
          .allowedFields
      ).toEqual(['status', 'HIDDEN', 'secret']);
      expect(
        resolve(
          { allowedFields: ['status', 'secret'] },
          { hidden: 'SECRET' },
          true
        ).allowedFields
      ).toEqual(['status', 'secret', 'hidden']);
      expect(
        resolve({ allowedFields: ['status', 'secret'] }, { hidden: 'SECRET' })
          .allowedFields
      ).toEqual(['status', 'secret']);
    });

    it('closes the keys of denyValues and unions values that land on one name', () => {
      expect(
        resolve({ denyValues: { hidden: ['a'] } }, alias).denyValues
      ).toEqual({
        hidden: ['a'],
        secret: ['a']
      });
      const union = resolve(
        { denyValues: { hidden: ['a'], secret: ['b'] } },
        alias
      ).denyValues;
      expect(union.hidden).toEqual(expect.arrayContaining(['a', 'b']));
      expect(union.secret).toEqual(expect.arrayContaining(['a', 'b']));
      expect(union.hidden).toHaveLength(2);
      expect(union.secret).toHaveLength(2);
    });

    it('moves an exclusion keyed by an alias under its target', () => {
      expect(
        resolve({ enforceExcludedValues: { hidden: ['a'] } }, alias)
          .enforceExcludedValues
      ).toEqual({ secret: ['a'] });
      expect(
        resolve({ enforceExcludedValues: { HIDDEN: ['a'] } }, alias)
          .enforceExcludedValues
      ).toEqual({ secret: ['a'] });
      expect(
        resolve(
          { enforceExcludedValues: { hidden: ['a'], secret: ['b'] } },
          alias
        ).enforceExcludedValues
      ).toEqual({ secret: ['a', 'b'] });
      expect(
        resolve({ enforceExcludedValues: { status: ['x'] } }, alias)
          .enforceExcludedValues
      ).toEqual({ status: ['x'] });
    });

    it('reads own mapping keys only and keeps the other options', () => {
      const inherited = Object.create({ hidden: 'secret' }) as Record<
        string,
        string
      >;
      const options = { ...DEFAULT_SECURITY_OPTIONS, denyFields: ['hidden'] };
      expect(aliasSecurityFields(options, inherited, false).denyFields).toEqual(
        ['hidden']
      );
      const resolved = resolve(
        { denyFields: ['hidden'], maxQueryDepth: 3 },
        alias
      );
      expect(resolved.maxQueryDepth).toBe(3);
      expect(resolved.maxClauseCount).toBe(
        DEFAULT_SECURITY_OPTIONS.maxClauseCount
      );
    });
  });

  describe('denyValues keyed by another spelling of the field', () => {
    it.each([
      [{ secret: ['a'] }, 'items.secret:a'],
      [{ secret: ['a'] }, 'Secret:a'],
      [{ secret: ['a'] }, 'secret:in[a, b]'],
      [{ secret: ['a'] }, 'NOT secret:a'],
      [{ SECRET: ['a'] }, 'secret:a'],
      [{ 'items.secret': ['a'] }, 'secret:a'],
      [{ 'items.secret': ['a'] }, 'Items.Secret:a']
    ])('denyValues %p rejects %s', (denyValues, query) => {
      const subject = new QuerySecurityValidator({ denyValues });
      expect(() => subject.validate(parser.parse(query))).toThrow(
        'Invalid query parameters'
      );
    });

    it('keeps an unlisted value and a two-dot name', () => {
      const subject = new QuerySecurityValidator({
        denyValues: { secret: ['a'] }
      });
      expect(() => subject.validate(parser.parse('secret:c'))).not.toThrow();
      expect(() =>
        subject.validate(parser.parse('a.b.secret:a'))
      ).not.toThrow();
    });
  });
});
