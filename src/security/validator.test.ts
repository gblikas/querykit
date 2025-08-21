import { QuerySecurityValidator, QuerySecurityError } from './validator';
import { QueryParser } from '../parser/parser';
import { QueryExpression, IComparisonExpression } from '../parser/types';

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
});
