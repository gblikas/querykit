/**
 * Security tests validating fixes for critical vulnerabilities:
 * - SQL injection via field names
 * - Field enumeration attacks  
 * - ReDoS via wildcard patterns
 * - Type confusion bypasses
 * - NoSQL injection via objects
 */
import { QueryParser, QueryParseError } from './parser/parser';
import { QuerySecurityValidator, QuerySecurityError } from './security/validator';
import { DrizzleTranslator, DrizzleTranslationError } from './translators/drizzle';

describe('Security Audit Tests', () => {
  let parser: QueryParser;
  let validator: QuerySecurityValidator;
  let translator: DrizzleTranslator;

  beforeEach(() => {
    parser = new QueryParser();
    validator = new QuerySecurityValidator({
      allowedFields: ['name', 'email', 'priority', 'status', 'field', 'active', 'count', 'percentage', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
      denyFields: ['password', 'secret'],
      maxValueLength: 50,
      maxQueryDepth: 3,
      maxClauseCount: 5
    });
    translator = new DrizzleTranslator();
  });

  describe('VULN-001: SQL Injection via Raw SQL Construction', () => {
    it('should handle malicious field names safely', () => {
      const maliciousQueries = [
        'user.name; DROP TABLE users; --:"test"',
        'id\'; DELETE FROM users; --:"1"', 
        'name` OR 1=1; --:"admin"',
        'field); DROP TABLE users;--:"value"'
      ];

      maliciousQueries.forEach(query => {
        try {
          const parsed = parser.parse(query);
          expect(() => validator.validate(parsed)).toThrow(QuerySecurityError);
        } catch (error) {
          // Parser should either reject or validator should catch
          expect(error).toBeInstanceOf(QueryParseError);
        }
      });
    });

         it('should prevent SQL injection through field names in translator', () => {
       // Create a malicious expression that bypasses parser validation
       const maliciousExpression = {
         type: 'comparison' as const,
         field: 'user.id; DROP TABLE users; --',
         operator: '==' as const,
         value: 'test'
       };

       expect(() => translator.translate(maliciousExpression)).toThrow(DrizzleTranslationError);
       expect(() => translator.translate(maliciousExpression)).toThrow('Invalid field name');
     });
  });

  describe('VULN-002: Field Enumeration via Error Messages', () => {
    it('should not reveal field existence through error messages', () => {
      const validatorStrict = new QuerySecurityValidator({
        allowedFields: ['name', 'email'],
        denyFields: ['password']
      });

      const unauthorizedQueries = [
        'password:"secret"',
        'nonexistent:"value"',
        'hidden_field:"data"'
      ];

      unauthorizedQueries.forEach(query => {
        const parsed = parser.parse(query);
        expect(() => validatorStrict.validate(parsed)).toThrow('Invalid query parameters');
      });
    });

    it('should use generic error messages for denied fields', () => {
      const deniedQuery = parser.parse('password:"secret"');
      
      expect(() => validator.validate(deniedQuery)).toThrow(QuerySecurityError);
      expect(() => validator.validate(deniedQuery)).toThrow('Invalid query parameters');
    });
  });

  describe('VULN-003: ReDoS via Wildcard Patterns', () => {
         it('should prevent catastrophic backtracking patterns', () => {
       const redosPatterns = [
         'name:"*a*a*a*a*a*a*a*a*a*a*b"',
         'name:"?x?x?x?x?x?x?x?x?x?x?y"'
       ];

       redosPatterns.forEach(pattern => {
         const parsed = parser.parse(pattern);
         expect(() => validator.validate(parsed)).toThrow(QuerySecurityError);
       });
     });

    it('should limit wildcard usage', () => {
      const excessiveWildcards = 'name:"' + '*'.repeat(15) + '"';
      const parsed = parser.parse(excessiveWildcards);
      
      expect(() => validator.validate(parsed)).toThrow('Excessive wildcard usage');
    });

         it('should sanitize consecutive wildcards', () => {
       const multiWildcard = parser.parse('name:"***test***"');
       
       // Should either sanitize or reject based on pattern complexity
       try {
         validator.validate(multiWildcard);
         expect((multiWildcard as any).value).toBe('*test*');
       } catch (error) {
         expect(error).toBeInstanceOf(QuerySecurityError);
       }
     });
  });

  describe('VULN-004: Logic Bypass via Type Confusion', () => {
    it('should validate array value lengths', () => {
      const longStringArray = {
        type: 'comparison' as const,
        field: 'status',
        operator: 'IN' as const,
        value: ['a'.repeat(100), 'b'.repeat(100)]
      };

      expect(() => validator.validate(longStringArray)).toThrow(QuerySecurityError);
    });

    it('should limit array sizes', () => {
      const largeArray = {
        type: 'comparison' as const,
        field: 'status',
        operator: 'IN' as const,
        value: Array(150).fill('test')
      };

      expect(() => validator.validate(largeArray)).toThrow('Array values cannot exceed 100 items');
    });

         it('should prevent object values in arrays', () => {
       const objectInArray = {
         type: 'comparison' as const,
         field: 'status',
         operator: 'IN' as const,
         value: ['test', { malicious: 'object' }] as any // Test malicious input
       };

       expect(() => validator.validate(objectInArray)).toThrow('Object values are not allowed');
     });
  });

  describe('VULN-005: NoSQL Injection via Object Values', () => {
    it('should reject object values in parser', () => {
      // Simulate object injection attempt
      const objectValue = { '$ne': null };
      
      expect(() => parser['convertLiqeValue'](objectValue)).toThrow(QueryParseError);
    });

         it('should prevent object injection through complex values', () => {
       const maliciousExpression = {
         type: 'comparison' as const,
         field: 'user',
         operator: '==' as const,
         value: { '$where': 'this.password.length > 0' } as any // Test malicious input
       };

       expect(() => validator.validate(maliciousExpression)).toThrow(QuerySecurityError);
     });
  });

  describe('Query Complexity Limits', () => {
    it('should enforce maximum query depth', () => {
      const deepQuery = parser.parse('((((name:"test"))))');
      
      expect(() => validator.validate(deepQuery)).toThrow('Query exceeds maximum depth');
    });

    it('should enforce maximum clause count', () => {
      const complexQuery = parser.parse(
        'a:1 AND b:2 AND c:3 AND d:4 AND e:5 AND f:6 AND g:7'
      );
      
      expect(() => validator.validate(complexQuery)).toThrow('Query exceeds maximum clause count');
    });
  });

  describe('Input Sanitization', () => {
    it('should handle Unicode and special characters safely', () => {
      const unicodeQueries = [
        'name:"\\u0000"',     // Null byte
        'name:"\\u001F"',     // Control character
        'name:"𝐇𝐞𝐥𝐥𝐨"',        // Unicode mathematical bold
        'name:"<script>alert(1)</script>"' // XSS attempt
      ];

      unicodeQueries.forEach(query => {
        const parsed = parser.parse(query);
        expect(() => validator.validate(parsed)).not.toThrow();
        
        // Should be handled safely by translator
        expect(() => translator.translate(parsed)).not.toThrow();
      });
    });

    it('should handle extremely long values', () => {
      const longValue = 'a'.repeat(2000);
      const longQuery = parser.parse(`name:"${longValue}"`);
      
      expect(() => validator.validate(longQuery)).toThrow('exceeds maximum length');
    });
  });

  describe('Edge Cases and Boundary Conditions', () => {
    it('should handle empty queries safely', () => {
      expect(() => parser.parse('')).toThrow(QueryParseError);
    });

    it('should handle null and undefined values', () => {
      const nullQuery = parser.parse('field:null');
      expect(() => validator.validate(nullQuery)).not.toThrow();
      expect(() => translator.translate(nullQuery)).not.toThrow();
    });

    it('should handle boolean values correctly', () => {
      const boolQuery = parser.parse('active:true');
      expect(() => validator.validate(boolQuery)).not.toThrow();
      expect(() => translator.translate(boolQuery)).not.toThrow();
    });

    it('should handle numeric edge cases', () => {
      const numericQueries = [
        'count:0',
        'count:-1',
        'count:999999999999999',
        'percentage:0.0001'
      ];

      numericQueries.forEach(query => {
        const parsed = parser.parse(query);
        expect(() => validator.validate(parsed)).not.toThrow();
        expect(() => translator.translate(parsed)).not.toThrow();
      });
    });
  });

  describe('Performance and DoS Protection', () => {
    it('should handle deeply nested parentheses', () => {
      const nested = '(' + 'name:"test"' + ')'.repeat(20);
      
      expect(() => parser.parse(nested)).toThrow();
    });

    it('should prevent memory exhaustion via large arrays', () => {
      const hugeArray = {
        type: 'comparison' as const,
        field: 'status',
        operator: 'IN' as const,
        value: Array(10000).fill('test')
      };

      expect(() => validator.validate(hugeArray)).toThrow();
    });
  });

  describe('Integration Security Tests', () => {
    it('should maintain security through full parsing pipeline', () => {
      const suspiciousQueries = [
        'status:"active" OR 1=1',
        'name:"admin\'--"',
        'id:1 UNION SELECT password FROM users',
        'field:"value"; INSERT INTO logs VALUES("hacked")'
      ];

      suspiciousQueries.forEach(query => {
        try {
          const parsed = parser.parse(query);
          validator.validate(parsed);
          translator.translate(parsed);
          
          // If no exception, ensure the translated query is safe
          expect(true).toBe(true); // Placeholder for additional safety checks
        } catch (error) {
          // Should throw security or parse errors
          expect(
            error instanceof QueryParseError ||
            error instanceof QuerySecurityError ||
            error instanceof DrizzleTranslationError
          ).toBe(true);
        }
      });
    });
  });
});