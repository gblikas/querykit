import { DrizzleAdapter, IDrizzleDatabase } from './index';
import { QueryParser } from '../../parser';
import { QueryExpression } from '../../parser/types';
import { SQL, SQLWrapper, sql } from 'drizzle-orm';
import {
  integer,
  sqliteTable,
  SQLiteSyncDialect,
  text
} from 'drizzle-orm/sqlite-core';

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

/**
 * Adapter over two tables whose property names differ from their columns.
 */
function createMultiTableAdapter(): DrizzleAdapter {
  const users = sqliteTable('users', {
    id: integer('id'),
    displayName: text('display_name'),
    active: integer('active', { mode: 'boolean' })
  });
  const teams = sqliteTable('teams', {
    id: integer('id'),
    name: text('name')
  });
  const adapter = new DrizzleAdapter();
  adapter.initialize({ db: mockDb, schema: { users, teams } });
  return adapter;
}

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

    it('resolves bare fields against the selected table of a multi-table schema', async () => {
      const multiTableAdapter = createMultiTableAdapter();
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'active',
        operator: '==',
        value: true
      };
      await multiTableAdapter.execute('users', expression);
      const condition = mockWhere.mock.calls[0][0] as SQL;
      const compiled = new SQLiteSyncDialect().sqlToQuery(condition);
      expect(compiled.sql).toBe('"users"."active" = ?');
      expect(compiled.params).toEqual([1]);
    });

    it('renames a bare property to its column name on the selected table', async () => {
      const multiTableAdapter = createMultiTableAdapter();
      await multiTableAdapter.execute('users', parser.parse('displayName:Ada'));
      const condition = mockWhere.mock.calls[0][0] as SQL;
      const compiled = new SQLiteSyncDialect().sqlToQuery(condition);
      expect(compiled.sql).toBe('"users"."display_name" = ?');
      expect(compiled.params).toEqual(['Ada']);
    });

    it('does not resolve inherited object properties as tables', async () => {
      const expression = parser.parse('status:"active"');
      for (const tableName of ['constructor', 'toString', 'hasOwnProperty']) {
        await expect(
          adapter.execute(tableName, expression, { orderBy: { name: 'asc' } })
        ).rejects.toThrow(`Table ${tableName} not found in schema`);
      }
      expect(mockFrom).not.toHaveBeenCalled();
      expect(mockOrderBy).not.toHaveBeenCalled();
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
     * external/untrusted input sources. Anything other than asc or desc is
     * rejected before an ORDER BY clause is built; it is never coerced to a
     * default direction.
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

    const rejectedDirections: string[] = [
      'asc; DROP TABLE todos;--',
      'asc; SELECT title FROM todos--',
      'desc); DELETE FROM todos;--',
      'ASC LIMIT 1; --',
      '" OR 1=1 --',
      'invalid_direction'
    ];

    it.each(rejectedDirections)(
      'rejects direction %p before any ORDER BY is built',
      async (direction: string) => {
        const expression = parser.parse('status:"active"');
        await expect(
          adapter.execute('todos', expression, {
            orderBy: { unknownField: direction as 'asc' | 'desc' }
          })
        ).rejects.toThrow(`Invalid sort direction: ${direction}`);
        expect(mockOrderBy).not.toHaveBeenCalled();
      }
    );

    it('rejects an invalid direction for a schema field as well', async () => {
      const expression = parser.parse('status:"active"');
      await expect(
        adapter.execute('todos', expression, {
          orderBy: { title: 'invalid_direction' as 'asc' | 'desc' }
        })
      ).rejects.toThrow('Invalid sort direction: invalid_direction');
      expect(mockOrderBy).not.toHaveBeenCalled();
    });

    it('accepts DESC in upper case for an unmapped field', async () => {
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        orderBy: { unknownField: 'DESC' as 'desc' }
      });
      expect(mockOrderBy).toHaveBeenCalled();
      expect(getOrderBySqlString()).toContain('DESC');
    });
  });

  describe('orderBy field resolution', () => {
    const dialect = new SQLiteSyncDialect();

    function compiledOrderBy(): string {
      const clause = mockOrderBy.mock.calls[0][0] as SQL;
      return dialect.sqlToQuery(clause).sql;
    }

    it('sorts ASC when the runtime direction is uppercase and the field is in the schema', async (): Promise<void> => {
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        orderBy: { title: 'ASC' as 'asc' }
      });
      expect(compiledOrderBy().toLowerCase()).toBe('title asc');
    });

    it('applies field mappings before choosing an order column', async (): Promise<void> => {
      adapter.initialize({
        db: mockDb,
        schema: mockSchema,
        fieldMappings: { displayName: 'title' }
      });
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        orderBy: { displayName: 'asc' }
      });
      expect(compiledOrderBy().toLowerCase()).toBe('title asc');
    });

    it('normalizes field names before choosing an order column', async (): Promise<void> => {
      adapter.initialize({
        db: mockDb,
        schema: mockSchema,
        normalizeFieldNames: true
      });
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        orderBy: { Title: 'asc' }
      });
      expect(compiledOrderBy().toLowerCase()).toBe('title asc');
    });

    it('resolves a table-qualified order field onto the current table column', async (): Promise<void> => {
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        orderBy: { 'todos.title': 'asc' }
      });
      expect(compiledOrderBy().toLowerCase()).toBe('title asc');
    });

    it('rejects order fields that break out of a quoted identifier', async (): Promise<void> => {
      const expression = parser.parse('status:"active"');
      await expect(
        adapter.execute('todos', expression, {
          orderBy: { 'title"; DROP TABLE todos;--': 'asc' }
        })
      ).rejects.toThrow(/Invalid field name/);
    });

    it('does not treat inherited properties as order columns', async (): Promise<void> => {
      const expression = parser.parse('status:"active"');
      await adapter.execute('todos', expression, {
        orderBy: { toString: 'asc' }
      });
      expect(compiledOrderBy()).toBe('"toString" ASC');
    });
  });
});

describe('DrizzleAdapter sort direction validation', () => {
  it('rejects a direction that is neither asc nor desc instead of sorting DESC', async () => {
    jest.clearAllMocks();
    const directionAdapter = new DrizzleAdapter();
    directionAdapter.initialize({ db: mockDb, schema: mockSchema });
    const expression: QueryExpression = {
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: 'active'
    };
    await expect(
      directionAdapter.execute('todos', expression, {
        orderBy: { title: 'invalid' as 'asc' }
      })
    ).rejects.toThrow('Invalid sort direction: invalid');
    expect(mockOrderBy).not.toHaveBeenCalled();
  });

  it('accepts asc and desc in any letter case', async () => {
    jest.clearAllMocks();
    const directionAdapter = new DrizzleAdapter();
    directionAdapter.initialize({ db: mockDb, schema: mockSchema });
    const expression: QueryExpression = {
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: 'active'
    };
    await directionAdapter.execute('todos', expression, {
      orderBy: { title: 'DESC' as 'desc', priority: 'asc' }
    });
    expect(mockOrderBy).toHaveBeenCalledTimes(1);
  });
});
