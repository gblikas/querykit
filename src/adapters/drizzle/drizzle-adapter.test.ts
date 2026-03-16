import { DrizzleAdapter, IDrizzleDatabase } from './index';
import { QueryParser } from '../../parser';
import { QueryExpression } from '../../parser/types';
import { SQLWrapper, sql } from 'drizzle-orm';

// Create mocks
const mockWhere = jest.fn().mockReturnThis();
const mockOrderBy = jest.fn().mockReturnThis();
const mockLimit = jest.fn().mockReturnThis();
const mockOffset = jest.fn().mockReturnThis();
const mockFrom = jest.fn().mockReturnValue({
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
  offset: mockOffset,
  then: <T>(callback: (value: unknown[]) => T) =>
    Promise.resolve(callback([{ id: 1, title: 'Test Todo' }]))
});
const mockSelect = jest.fn().mockReturnValue({ from: mockFrom });

// Create a mock DB instance
const mockDb: IDrizzleDatabase = {
  select: mockSelect
};

// Create mock schema with SQLWrapper fields
const mockSchema = {
  todos: {
    id: sql.raw('id') as unknown as SQLWrapper,
    title: sql.raw('title') as unknown as SQLWrapper,
    priority: sql.raw('priority') as unknown as SQLWrapper,
    status: sql.raw('status') as unknown as SQLWrapper
  }
};

describe('DrizzleAdapter', () => {
  let adapter: DrizzleAdapter;
  let parser: QueryParser;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create fresh instances
    adapter = new DrizzleAdapter();
    parser = new QueryParser();

    // Initialize the adapter
    adapter.initialize({
      db: mockDb,
      schema: mockSchema
    });
  });

  describe('execute', () => {
    it('should execute a simple query', async () => {
      const expression = parser.parse('title:"Test Todo"');
      const result = await adapter.execute('todos', expression);

      expect(mockSelect).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();
      expect(result).toEqual([{ id: 1, title: 'Test Todo' }]);
    });

    it('should support ordering', async () => {
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        orderBy: { title: 'asc' }
      });

      expect(mockOrderBy).toHaveBeenCalled();
    });

    it('should support limit', async () => {
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        limit: 10
      });

      expect(mockLimit).toHaveBeenCalledWith(10);
    });

    it('should support offset', async () => {
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        offset: 20
      });

      expect(mockOffset).toHaveBeenCalledWith(20);
    });

    it('should throw error if table not found', async () => {
      const expression = parser.parse('status:"active"');

      await expect(
        adapter.execute('unknown_table', expression)
      ).rejects.toThrow('Table unknown_table not found in schema');
    });
  });

  describe('canExecute', () => {
    it('should return true for valid expressions', () => {
      const expression = parser.parse('status:"active"');
      expect(adapter.canExecute(expression)).toBe(true);
    });

    it('should return false for invalid expressions', () => {
      const invalidExpression = {
        type: 'unsupported'
      } as unknown as QueryExpression;
      expect(adapter.canExecute(invalidExpression)).toBe(false);
    });
  });

  describe('orderBy security (SQL injection prevention)', () => {
    /**
     * Security tests for SQL injection prevention in orderBy direction.
     *
     * These tests use type assertions (e.g., `as 'asc' | 'desc'`) to simulate
     * runtime scenarios where TypeScript's type safety is bypassed, such as:
     * - User input from API requests (REST, GraphQL)
     * - Query parameters from URLs
     * - Server actions receiving client-controlled data
     *
     * While TypeScript provides compile-time safety, runtime validation is
     * essential for defense-in-depth, especially when QueryKit is used with
     * external/untrusted input sources.
     */

    // Helper function to extract the SQL string from the orderBy call
    const getOrderBySqlString = (): string => {
      const orderByCall = mockOrderBy.mock.calls[0];
      if (orderByCall && orderByCall[0]) {
        // The SQL object should have a queryChunks property we can inspect
        const sqlObj = orderByCall[0];
        // Convert to string representation for testing
        return JSON.stringify(sqlObj);
      }
      return '';
    };

    it('should safely handle direction when field exists in schema', async () => {
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        orderBy: { title: 'asc' }
      });

      expect(mockOrderBy).toHaveBeenCalled();
      // When field exists in schema, the safe asc/desc functions are used
    });

    it('should normalize direction to ASC/DESC only when field is NOT in schema', async () => {
      const expression = parser.parse('status:"active"');

      // Simulate runtime input that bypasses TypeScript safety
      // This could come from: req.query.sort, JSON.parse(body), etc.
      await adapter.execute('todos', expression, {
        orderBy: { unknownField: 'asc; DROP TABLE users;--' as 'asc' | 'desc' }
      });

      expect(mockOrderBy).toHaveBeenCalled();

      // The SQL generated should NOT contain the injection payload
      const sqlString = getOrderBySqlString();
      expect(sqlString).not.toContain('DROP TABLE');
      expect(sqlString).not.toContain(';');
      expect(sqlString).not.toContain('--');
    });

    it('should normalize malicious direction with SELECT injection to safe value', async () => {
      const expression = parser.parse('status:"active"');

      await adapter.execute('todos', expression, {
        orderBy: {
          unknownField: 'asc; SELECT password FROM users--' as 'asc' | 'desc'
        }
      });

      expect(mockOrderBy).toHaveBeenCalled();

      const sqlString = getOrderBySqlString();
      expect(sqlString).not.toContain('SELECT');
      expect(sqlString).not.toContain('password');
      expect(sqlString).not.toContain('users');
    });

    it('should handle DESC with injection payload safely', async () => {
      const expression = parser.parse('status:"active"');

      await adapter.execute('todos', expression, {
        orderBy: {
          unknownField: 'desc); DELETE FROM users;--' as 'asc' | 'desc'
        }
      });

      expect(mockOrderBy).toHaveBeenCalled();

      const sqlString = getOrderBySqlString();
      expect(sqlString).not.toContain('DELETE');
      expect(sqlString).not.toContain(');');
    });

    it('should handle uppercase ASC with injection safely', async () => {
      const expression = parser.parse('status:"active"');

      await adapter.execute('todos', expression, {
        orderBy: {
          unknownField: 'ASC LIMIT 1; --' as 'asc' | 'desc'
        }
      });

      expect(mockOrderBy).toHaveBeenCalled();

      const sqlString = getOrderBySqlString();
      expect(sqlString).not.toContain('LIMIT');
    });

    it('should handle OR injection attempt safely', async () => {
      const expression = parser.parse('status:"active"');

      await adapter.execute('todos', expression, {
        orderBy: {
          unknownField: '" OR 1=1 --' as 'asc' | 'desc'
        }
      });

      expect(mockOrderBy).toHaveBeenCalled();

      const sqlString = getOrderBySqlString();
      expect(sqlString).not.toContain(' OR ');
      expect(sqlString).not.toContain('1=1');
    });

    it('should default invalid direction to DESC (safe fallback)', async () => {
      const expression = parser.parse('status:"active"');

      await adapter.execute('todos', expression, {
        orderBy: {
          unknownField: 'invalid_direction' as 'asc' | 'desc'
        }
      });

      expect(mockOrderBy).toHaveBeenCalled();

      // The direction should be normalized - either ASC or DESC only
      const sqlString = getOrderBySqlString();
      // Should NOT contain the raw invalid direction
      expect(sqlString).not.toContain('INVALID_DIRECTION');
      // Should contain the safe fallback value (DESC when input is not 'asc')
      expect(sqlString).toContain('DESC');
    });
  });
});
