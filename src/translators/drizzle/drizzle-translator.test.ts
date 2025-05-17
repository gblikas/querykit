import { QueryParser } from '../../parser';
import { QueryExpression } from '../../parser/types';
import { DrizzleTranslator } from './';
import { SQL, sql } from 'drizzle-orm';

// Helper function to safely get SQL string value for testing
function getSqlString(sqlObj: SQL): string {
  // For testing purposes only - extract a string representation
  // of the SQL query that we can use in our assertions
  try {
    return JSON.stringify(sqlObj);
  } catch (e) {
    return String(sqlObj);
  }
}

describe('DrizzleTranslator', () => {
  const translator = new DrizzleTranslator();
  const parser = new QueryParser();

  describe('translate', () => {
    it('should translate a simple comparison expression', () => {
      const expression = parser.parse('priority:>2');
      const result = translator.translate(expression);

      const sqlString = getSqlString(result);
      expect(sqlString).toContain('priority');
      expect(sqlString).toContain('>');
      expect(sqlString).toContain('2');
    });

    it('should translate a logical AND expression', () => {
      const expression = parser.parse('priority:>2 AND status:"active"');
      const result = translator.translate(expression);

      const sqlString = getSqlString(result);
      expect(sqlString).toContain('AND');
      expect(sqlString).toContain('priority');
      expect(sqlString).toContain('status');
    });

    it('should translate a logical OR expression', () => {
      const expression = parser.parse('status:"active" OR status:"pending"');
      const result = translator.translate(expression);

      const sqlString = getSqlString(result);
      expect(sqlString).toContain('OR');
    });

    it('should translate a NOT expression', () => {
      const expression = parser.parse('NOT status:"inactive"');
      const result = translator.translate(expression);

      const sqlString = getSqlString(result);
      expect(sqlString).toContain('NOT');
    });

    it('should translate multiple values as OR conditions', () => {
      // Create a logical OR expression that checks for multiple values
      const expression = parser.parse('status:"active" OR status:"pending"');
      const result = translator.translate(expression);

      const sqlString = getSqlString(result);
      expect(sqlString).toContain('OR');
    });

    it('should translate a complex nested expression', () => {
      const expression = parser.parse(
        '(priority:>2 AND status:"active") OR (role:"admin")'
      );
      const result = translator.translate(expression);

      const sqlString = getSqlString(result);
      expect(sqlString).toContain('AND');
      expect(sqlString).toContain('OR');
      expect(sqlString).toContain('priority');
    });
  });

  describe('with schema', () => {
    // Mock schema with some table fields
    const mockSchema = {
      todos: {
        id: sql.raw('todos.id') as unknown as SQL,
        title: sql.raw('todos.title') as unknown as SQL,
        priority: sql.raw('todos.priority') as unknown as SQL,
        status: sql.raw('todos.status') as unknown as SQL
      }
    };

    const schemaTranslator = new DrizzleTranslator({
      schema: mockSchema
    });

    it('should use schema fields when available', () => {
      const expression = parser.parse('todos.priority:>2');
      const result = schemaTranslator.translate(expression);

      const sqlString = getSqlString(result);
      expect(sqlString).toContain('>');
    });
  });

  describe('canTranslate', () => {
    it('should return true for valid expressions', () => {
      const expression = parser.parse('status:"active"');
      expect(translator.canTranslate(expression)).toBe(true);
    });

    it('should handle unsupported expressions gracefully', () => {
      // Create a malformed expression to test error handling
      const invalidExpression = {
        type: 'unsupported'
      } as unknown as QueryExpression;
      expect(translator.canTranslate(invalidExpression)).toBe(false);
    });
  });

  describe('table qualification', () => {
    it('should preserve table qualifiers in fields', () => {
      const expression = parser.parse('todos.priority:>2');
      const result = translator.translate(expression);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('todos.priority');
    });
  });
});
