import { QueryParser } from '../../parser';
import { QueryExpression } from '../../parser/types';
import {
  SqlTranslator,
  SqlTranslationError,
  ISqlTranslationResult
} from './index';

describe('SqlTranslator', () => {
  const translator = new SqlTranslator({ useParameters: false });
  const parser = new QueryParser();

  describe('translate', () => {
    it('should translate a simple equality expression', () => {
      const expression = parser.parse('name:"John"');
      const result = translator.translate(expression) as string;

      expect(result).toBe('"name" = \'John\'');
    });

    it('should translate a comparison expression', () => {
      const expression = parser.parse('priority:>18');
      const result = translator.translate(expression) as string;

      expect(result).toBe('"priority" > 18');
    });

    it('should translate numeric values directly', () => {
      const expression = parser.parse('count:42');
      const result = translator.translate(expression) as string;

      expect(result).toBe('"count" = 42');
    });

    it('should translate boolean values correctly', () => {
      const expression = parser.parse('active:true');
      const result = translator.translate(expression) as string;

      expect(result).toBe('"active" = true');
    });

    it('should translate a simple comparison expression', () => {
      const expression = parser.parse('priority:>2');
      const result = translator.translate(expression) as string;

      expect(result).toBe('"priority" > 2');
    });

    it('should translate a logical AND expression', () => {
      const expression = parser.parse('priority:>2 AND status:"active"');
      const result = translator.translate(expression) as string;

      expect(result).toBe('("priority" > 2) AND ("status" = \'active\')');
    });

    it('should translate a logical OR expression', () => {
      const expression = parser.parse('status:"active" OR status:"pending"');
      const result = translator.translate(expression) as string;

      expect(result).toBe(
        '("status" = \'active\') OR ("status" = \'pending\')'
      );
    });

    it('should translate a NOT expression', () => {
      const expression = parser.parse('NOT status:"inactive"');
      const result = translator.translate(expression) as string;

      expect(result).toBe('NOT ("status" = \'inactive\')');
    });

    it('should translate a complex nested expression', () => {
      const expression = parser.parse(
        '(priority:>2 AND status:"active") OR (role:"admin")'
      );
      const result = translator.translate(expression) as string;

      expect(result).toBe(
        '(("priority" > 2) AND ("status" = \'active\')) OR ("role" = \'admin\')'
      );
    });

    it('should handle null values correctly', () => {
      // Create a comparison expression with null value
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'last_login',
        operator: '==',
        value: null
      };

      const result = translator.translate(expression) as string;
      expect(result).toBe('"last_login" IS NULL');

      // Not equals with null
      const notNullExpression: QueryExpression = {
        type: 'comparison',
        field: 'last_login',
        operator: '!=',
        value: null
      };

      const notNullResult = translator.translate(notNullExpression) as string;
      expect(notNullResult).toBe('"last_login" IS NOT NULL');
    });

    it('should handle IN operator with array values', () => {
      // Create an IN expression
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: 'IN',
        value: ['active', 'pending', 'reviewing']
      };

      const result = translator.translate(expression) as string;
      expect(result).toBe("\"status\" IN ('active', 'pending', 'reviewing')");
    });

    it('should handle NOT IN operator with array values', () => {
      // Create a NOT IN expression
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: 'NOT IN',
        value: ['inactive', 'closed']
      };

      const result = translator.translate(expression) as string;
      expect(result).toBe("\"status\" NOT IN ('inactive', 'closed')");
    });

    it('should handle empty IN arrays properly', () => {
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: 'IN',
        value: []
      };

      const result = translator.translate(expression) as string;
      expect(result).toBe('FALSE');
    });

    it('should handle empty NOT IN arrays properly', () => {
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: 'NOT IN',
        value: []
      };

      const result = translator.translate(expression) as string;
      expect(result).toBe('TRUE');
    });

    it('should handle table.column notation', () => {
      const expression = parser.parse('users.priority:>2');
      const result = translator.translate(expression) as string;

      expect(result).toBe('"users"."priority" > 2');
    });

    it('should properly escape string values with quotes', () => {
      const expression = parser.parse('message:"It\'s a test"');
      const result = translator.translate(expression) as string;

      expect(result).toBe("\"message\" = 'It''s a test'");
    });

    it('should translate a combined expression with AND', () => {
      const expression = parser.parse('priority:>2 AND status:"active"');
      const sql = translator.translate(expression);

      expect(sql).toContain('"priority" > 2');
      expect(sql).toContain('"status" = ');
      expect(sql).toContain('AND');
    });
  });

  describe('with different quote options', () => {
    it('should use custom identifier quotes', () => {
      const mysqlTranslator = new SqlTranslator({
        identifierQuote: '`',
        useParameters: false
      });

      const expression = parser.parse('name:"John"');
      const result = mysqlTranslator.translate(expression) as string;

      expect(result).toBe("`name` = 'John'");
    });

    it('should use custom string literal quotes', () => {
      const mssqlTranslator = new SqlTranslator({
        stringLiteralQuote: '"',
        useParameters: false
      });

      const expression = parser.parse('name:"John"');
      const result = mssqlTranslator.translate(expression) as string;

      expect(result).toBe('"name" = "John"');
    });
  });

  describe('with parameters', () => {
    const paramTranslator = new SqlTranslator({
      useParameters: true
    });

    it('should use parameters for simple values', () => {
      const expression = parser.parse('name:"John"');
      const result = paramTranslator.translate(
        expression
      ) as ISqlTranslationResult;

      expect(result.sql).toBe('"name" = ?');
      expect(result.params).toEqual(['John']);
    });

    it('should use parameters for comparison operators', () => {
      const expression = parser.parse('priority:>18');
      const result = paramTranslator.translate(
        expression
      ) as ISqlTranslationResult;

      expect(result.sql).toBe('"priority" > ?');
      expect(result.params).toEqual([18]);
    });

    it('should use parameters for complex expressions', () => {
      const expression = parser.parse(
        '(priority:>18 AND status:"active") OR (role:"admin")'
      );
      const result = paramTranslator.translate(
        expression
      ) as ISqlTranslationResult;

      expect(result.sql).toBe(
        '(("priority" > ?) AND ("status" = ?)) OR ("role" = ?)'
      );
      expect(result.params).toEqual([18, 'active', 'admin']);
    });

    it('should use parameters for IN clauses', () => {
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: 'IN',
        value: ['active', 'pending']
      };

      const result = paramTranslator.translate(
        expression
      ) as ISqlTranslationResult;
      expect(result.sql).toBe('"status" IN (?, ?)');
      expect(result.params).toEqual(['active', 'pending']);
    });
  });

  describe('with field mappings', () => {
    const mappingTranslator = new SqlTranslator({
      fieldMappings: {
        user_id: 'users.id',
        user_name: 'users.name'
      },
      useParameters: false
    });

    it('should apply field mappings', () => {
      const expression = parser.parse('user_id:123');
      const result = mappingTranslator.translate(expression) as string;

      expect(result).toBe('"users"."id" = 123');
    });

    it('should apply field mappings in complex expressions', () => {
      const expression = parser.parse('user_id:>100 AND user_name:"John"');
      const result = mappingTranslator.translate(expression) as string;

      expect(result).toBe(
        '("users"."id" > 100) AND ("users"."name" = \'John\')'
      );
    });
  });

  describe('with table prefixes', () => {
    it('should preserve table prefixes in field names', () => {
      const expression = parser.parse('users.priority:>2');
      const sql = translator.translate(expression);

      expect(sql).toContain('"users"."priority"');
    });
  });

  describe('canTranslate', () => {
    it('should return true for valid expressions', () => {
      const expression = parser.parse('priority:>2');
      expect(translator.canTranslate(expression)).toBe(true);
    });

    it('should return false for unsupported expressions', () => {
      // Create a malformed expression to test error handling
      const invalidExpression = {
        type: 'unsupported'
      } as unknown as QueryExpression;
      expect(translator.canTranslate(invalidExpression)).toBe(false);
    });

    it('should return false for invalid operators', () => {
      const invalidExpression = {
        type: 'comparison',
        field: 'name',
        operator: '=~', // Invalid operator
        value: 'pattern'
      } as unknown as QueryExpression;

      expect(translator.canTranslate(invalidExpression)).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should throw error for empty expressions', () => {
      expect(() =>
        translator.translate(null as unknown as QueryExpression)
      ).toThrow(SqlTranslationError);
    });

    it('should throw error for invalid expression types', () => {
      const invalidExpression = {
        type: 'unknown'
      } as unknown as QueryExpression;

      expect(() => translator.translate(invalidExpression)).toThrow(
        SqlTranslationError
      );
    });

    it('should throw error for invalid operator', () => {
      const invalidExpression = {
        type: 'comparison',
        field: 'name',
        operator: '=~', // Invalid operator
        value: 'pattern'
      } as unknown as QueryExpression;

      expect(() => translator.translate(invalidExpression)).toThrow(
        SqlTranslationError
      );
    });

    it('should throw error for IN operator with non-array value', () => {
      const invalidExpression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: 'IN',
        value: 'not-an-array'
      };

      expect(() => translator.translate(invalidExpression)).toThrow(
        SqlTranslationError
      );
    });

    it('should throw error for invalid value types', () => {
      // Access the private formatValue method for direct testing
      const formatValue = translator['formatValue'].bind(translator);

      // Test with a complex object (which is not a valid QueryValue but might be passed incorrectly)
      expect(() => formatValue({ complex: 'object' })).toThrow(
        SqlTranslationError
      );

      // Test with a symbol (also not a valid QueryValue)
      expect(() => formatValue(Symbol('test'))).toThrow(SqlTranslationError);
    });

    it('should throw error for logical expressions without right operand', () => {
      const invalidExpression: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'comparison',
          field: 'name',
          operator: '==',
          value: 'John'
        }
        // Missing right operand
      };

      expect(() => translator.translate(invalidExpression)).toThrow(
        SqlTranslationError
      );
    });
  });

  describe('with options', () => {
    it('should allow customization of output format', () => {
      const expression = parser.parse('priority:>2');
      const paramTranslator = new SqlTranslator({ useParameters: true });
      const result = paramTranslator.translate(expression);

      expect(typeof result).toBe('object');
    });

    it('should handle complex expressions with parameterization', () => {
      const expr = '(priority:>2 AND status:"active") OR (role:"admin")';
      const expression = parser.parse(expr);
      const paramTranslator = new SqlTranslator({ useParameters: true });
      const result = paramTranslator.translate(
        expression
      ) as ISqlTranslationResult;

      expect(typeof result).toBe('object');
      expect(Array.isArray(result.params)).toBe(true);
    });
  });
});
