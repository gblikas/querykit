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
});
