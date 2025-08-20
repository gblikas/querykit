import { QueryParser } from './parser';
import { DrizzleTranslator } from './translators/drizzle';
import { DrizzleAdapter, IDrizzleDatabase } from './adapters/drizzle';
import { SQLWrapper, SQL, sql } from 'drizzle-orm';
import { createQueryBuilder, createQueryKit } from './index';

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

// Define a user type for testing
interface ITodo {
  id: number;
  title: string;
  priority: number;
  status: string;
}

describe('QueryKit Integration Tests', () => {
  // Set up mocks for the Drizzle adapter
  const mockWhere = jest.fn().mockReturnThis();
  const mockOrderBy = jest.fn().mockReturnThis();
  const mockLimit = jest.fn().mockReturnThis();
  const mockOffset = jest.fn().mockReturnThis();
  const mockFrom = jest.fn().mockReturnValue({
    where: mockWhere,
    orderBy: mockOrderBy,
    limit: mockLimit,
    offset: mockOffset,
    then: <T>(callback: (value: ITodo[]) => T) =>
      Promise.resolve(
        callback([
          { id: 1, title: 'Buy groceries', priority: 2, status: 'active' },
          { id: 2, title: 'Fix bug', priority: 3, status: 'active' }
        ])
      )
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

  // Set up the adapter
  const adapter = new DrizzleAdapter();
  adapter.initialize({
    db: mockDb,
    schema: mockSchema
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('End-to-end Query', () => {
    it('should parse, translate and execute a query', async () => {
      // Parse a query expression
      const parser = new QueryParser();
      const expression = parser.parse('priority:>1 AND status:"active"');

      // Execute the query using the adapter
      const results = await adapter.execute<ITodo>('todos', expression);

      // Verify results
      expect(results).toHaveLength(2);
      expect(results[0].title).toBe('Buy groceries');
      expect(results[1].title).toBe('Fix bug');

      // Verify that the mocks were called correctly
      expect(mockSelect).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();

      // Verify the WHERE clause reflects the parsed query
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      expect(whereStr).toContain('priority');
      expect(whereStr.toLowerCase()).toContain('active');
    });

    it('should work with the query builder', async () => {
      // Create a query builder
      const queryBuilder = createQueryBuilder<ITodo>();

      // Build a query
      queryBuilder.where('priority', '>', 1).andWhere('status', '==', 'active');

      // Get the expression from the builder
      const expression = queryBuilder.getExpression();

      // Execute the query using the adapter
      const results = await adapter.execute<ITodo>('todos', expression);

      // Verify results
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe(1);
      expect(results[1].id).toBe(2);
    });
  });

  describe('Translation Pipeline', () => {
    it('should translate expressions consistently', () => {
      // Parse a query string
      const parser = new QueryParser();
      const stringExpression = parser.parse('status:"active" OR priority:>2');

      // Create the same expression with the builder
      const queryBuilder = createQueryBuilder<ITodo>();
      const builderExpression = queryBuilder
        .where('status', '==', 'active')
        .orWhere('priority', '>', 2)
        .getExpression();

      // Create a translator
      const translator = new DrizzleTranslator();

      // Translate both expressions
      const stringTranslated = translator.translate(stringExpression);
      const builderTranslated = translator.translate(builderExpression);

      // The SQL from both translations should have the same structure
      // (We can't directly compare SQL objects)
      const stringTranslatedStr = getSqlString(stringTranslated);
      const builderTranslatedStr = getSqlString(builderTranslated);

      expect(stringTranslatedStr).toContain('OR');
      expect(builderTranslatedStr).toContain('OR');

      // Both translations should contain similar structural elements
      // (Avoiding exact string matches as SQL objects might differ in representation)
      if (
        stringTranslatedStr.includes('status') &&
        builderTranslatedStr.includes('status')
      ) {
        expect(true).toBe(true); // Both contain 'status'
      } else {
        expect(stringTranslatedStr).toContain('status');
        expect(builderTranslatedStr).toContain('status');
      }

      if (
        stringTranslatedStr.includes('priority') &&
        builderTranslatedStr.includes('priority')
      ) {
        expect(true).toBe(true); // Both contain 'priority'
      } else {
        expect(stringTranslatedStr).toContain('priority');
        expect(builderTranslatedStr).toContain('priority');
      }
    });
  });

  describe('Fluent API execution', () => {
    it('executes a fluent query via createQueryKit', async () => {
      const adapter = new DrizzleAdapter();
      adapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } }
      });

      const results = await qk
        .query('todos')
        .where('priority:>1 AND status:"active"')
        .orderBy('priority', 'desc')
        .limit(10)
        .execute();

      expect(results).toHaveLength(2);
      expect(mockSelect).toHaveBeenCalled();
      expect(mockFrom).toHaveBeenCalled();
      expect(mockWhere).toHaveBeenCalled();
      expect(mockOrderBy).toHaveBeenCalled();
      expect(mockLimit).toHaveBeenCalledWith(10);

      // Verify WHERE clause from fluent path
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      expect(whereStr).toContain('priority');
      expect(whereStr.toLowerCase()).toContain('active');
    });
  });
});
