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

  describe('enforceExcludedValues', () => {
    it('should inject status NOT IN (archived, deleted) when enforceExcludedValues is configured', async () => {
      const adapter = new DrizzleAdapter();
      adapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        security: {
          enforceExcludedValues: {
            status: ['archived', 'deleted']
          }
        }
      });

      await qk.query('todos').where('priority:>1').execute();

      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      // The enforced exclusions should produce: status NOT IN ('archived', 'deleted')
      expect(whereStr).toContain('status');
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('deleted');
    });

    it('should inject NOT IN filters for multiple fields, each on the correct field', async () => {
      const adapter = new DrizzleAdapter();
      adapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        security: {
          enforceExcludedValues: {
            status: ['archived', 'deleted'],
            priority: [0]
          }
        }
      });

      await qk.query('todos').where('title:"test"').execute();

      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      // Both fields should have NOT IN applied
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('status');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('priority');
    });

    it('should not inject anything when enforceExcludedValues is empty', async () => {
      const adapter = new DrizzleAdapter();
      adapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        security: {
          enforceExcludedValues: {}
        }
      });

      await qk.query('todos').where('priority:>1').execute();

      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      // Should not contain NOT IN when no exclusions configured
      expect(whereStr.toLowerCase()).not.toContain('not in');
    });

    it('should not inject anything when enforceExcludedValues is not configured', async () => {
      const adapter = new DrizzleAdapter();
      adapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } }
        // no security option at all
      });

      await qk.query('todos').where('priority:>1').execute();

      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      expect(whereStr.toLowerCase()).not.toContain('not in');
    });

    it('should block queries referencing denied values, and enforce exclusions on safe queries', async () => {
      // This is the critical interaction test:
      // Given status: ['published', 'archived', 'deleted']
      // denyValues prevents referencing archived/deleted in the query
      // enforceExcludedValues ensures archived/deleted records are NEVER returned,
      // even when the user writes something like NOT status:published (which implicitly
      // includes archived and deleted records).
      const adapter = new DrizzleAdapter();
      adapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        security: {
          denyValues: { status: ['archived', 'deleted'] },
          enforceExcludedValues: { status: ['archived', 'deleted'] }
        }
      });

      // 1. Querying a denied value directly should throw
      await expect(
        qk.query('todos').where('NOT status:deleted').execute()
      ).rejects.toThrow();

      // 2. Querying a non-denied value passes denyValues validation.
      //    BUT "NOT status:published" without enforceExcludedValues would return
      //    archived and deleted records. With enforceExcludedValues, those are excluded.
      jest.clearAllMocks();
      await qk.query('todos').where('NOT status:published').execute();

      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      // enforceExcludedValues injects: AND status NOT IN ('archived', 'deleted')
      // ensuring only status:active (or other non-excluded values) can be returned
      expect(whereStr).toContain('status');
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('deleted');
    });

    it('should skip fields with empty value arrays in enforceExcludedValues', async () => {
      const adapter = new DrizzleAdapter();
      adapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        security: {
          enforceExcludedValues: {
            status: [] // empty array should be skipped
          }
        }
      });

      await qk.query('todos').where('priority:>1').execute();

      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      expect(whereStr.toLowerCase()).not.toContain('not in');
    });
  });

  describe('denyValues + enforceExcludedValues robustness', () => {
    // Shared QueryKit used for all attack scenarios in this suite.
    // denyValues: blocked if query *mentions* archived/deleted in any form.
    // enforceExcludedValues: guarantees those rows never appear, regardless of query.
    let qk: ReturnType<typeof createQueryKit>;

    beforeEach(() => {
      jest.clearAllMocks();
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });
      qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        security: {
          denyValues: { status: ['archived', 'deleted'] },
          enforceExcludedValues: { status: ['archived', 'deleted'] }
        }
      });
    });

    // ── Attack attempts that must be blocked by denyValues ─────────────────────

    it('should block a direct equality reference to a denied value', async () => {
      await expect(
        qk.query('todos').where('status:archived').execute()
      ).rejects.toThrow();
    });

    it('should block a NOT negation reference to the first denied value (archived)', async () => {
      await expect(
        qk.query('todos').where('NOT status:archived').execute()
      ).rejects.toThrow();
    });

    it('should block a NOT negation reference to the second denied value (deleted)', async () => {
      // Ensures each individual entry in the denyValues list is enforced,
      // not just the first one.
      await expect(
        qk.query('todos').where('NOT status:deleted').execute()
      ).rejects.toThrow();
    });

    it('should block a denied value hidden inside a compound AND query', async () => {
      // Even though priority:>1 is innocuous, the AND branch contains a denied value
      await expect(
        qk.query('todos').where('priority:>1 AND status:archived').execute()
      ).rejects.toThrow();
    });

    it('should block a denied value hidden inside a compound OR query', async () => {
      // OR is still a reference — the denied value must not appear in any form
      await expect(
        qk.query('todos').where('title:"test" OR status:deleted').execute()
      ).rejects.toThrow();
    });

    it('should block a denied value nested several levels deep', async () => {
      await expect(
        qk
          .query('todos')
          .where('(priority:>1 AND title:"test") AND status:archived')
          .execute()
      ).rejects.toThrow();
    });

    it('should block an IN operator that includes a denied value alongside allowed ones', async () => {
      // Mixed array: active is fine, but archived is denied → whole query rejected
      const mixedInExpr = {
        type: 'comparison' as const,
        field: 'status',
        operator: 'IN' as const,
        value: ['active', 'archived']
      };
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });
      const { QuerySecurityValidator } = await import('./security/validator');
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['archived', 'deleted'] }
      });
      expect(() => validator.validate(mixedInExpr)).toThrow();
    });

    it('should block an IN operator where all values are denied', async () => {
      const allDeniedExpr = {
        type: 'comparison' as const,
        field: 'status',
        operator: 'IN' as const,
        value: ['archived', 'deleted']
      };
      const { QuerySecurityValidator } = await import('./security/validator');
      const validator = new QuerySecurityValidator({
        denyValues: { status: ['archived', 'deleted'] }
      });
      expect(() => validator.validate(allDeniedExpr)).toThrow();
    });

    // ── Safe queries: must pass validation AND have NOT IN injected ────────────

    it('should pass status:active and still inject status NOT IN (archived, deleted)', async () => {
      // Explicit active filter passes denyValues; enforceExcludedValues still
      // injects NOT IN to be safe even if DB somehow held rows with both flags.
      await qk.query('todos').where('status:active').execute();

      const whereStr = getSqlString(
        mockWhere.mock.calls[0][0] as unknown as SQL
      );
      expect(whereStr).toContain('status');
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('deleted');
    });

    it('should pass a title query and inject status NOT IN (archived, deleted)', async () => {
      // Querying an entirely different field must still trigger the exclusion
      await qk.query('todos').where('title:"Buy groceries"').execute();

      const whereStr = getSqlString(
        mockWhere.mock.calls[0][0] as unknown as SQL
      );
      expect(whereStr).toContain('status');
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('deleted');
    });

    it('should pass priority:>1 and inject status NOT IN (archived, deleted)', async () => {
      await qk.query('todos').where('priority:>1').execute();

      const whereStr = getSqlString(
        mockWhere.mock.calls[0][0] as unknown as SQL
      );
      expect(whereStr).toContain('status');
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('deleted');
    });

    it('should pass a compound AND on safe fields and inject status NOT IN', async () => {
      await qk.query('todos').where('priority:>1 AND title:"test"').execute();

      const whereStr = getSqlString(
        mockWhere.mock.calls[0][0] as unknown as SQL
      );
      expect(whereStr).toContain('status');
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('deleted');
    });

    it('should pass NOT status:published and inject status NOT IN (archived, deleted)', async () => {
      // "NOT status:published" is the key bypass attempt: "published" is not a
      // denied value so denyValues passes it, but without enforceExcludedValues
      // the result set would include archived and deleted rows.
      // With enforceExcludedValues the injected NOT IN closes that gap.
      await qk.query('todos').where('NOT status:published').execute();

      const whereStr = getSqlString(
        mockWhere.mock.calls[0][0] as unknown as SQL
      );
      expect(whereStr).toContain('status');
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('deleted');
    });

    it('should pass a compound OR on safe fields and still inject status NOT IN', async () => {
      await qk.query('todos').where('priority:>5 OR title:"urgent"').execute();

      const whereStr = getSqlString(
        mockWhere.mock.calls[0][0] as unknown as SQL
      );
      expect(whereStr).toContain('status');
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('deleted');
    });

    it('should pass status:active and still inject status NOT IN for a separate query kit instance', async () => {
      // IN with only non-denied values is allowed; NOT IN is still appended
      // to ensure no excluded rows slip through regardless of query phrasing.
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });
      const safeInQk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        security: {
          denyValues: { status: ['archived', 'deleted'] },
          enforceExcludedValues: { status: ['archived', 'deleted'] }
        }
      });
      // status:active is not a denied value, so it passes denyValues;
      // enforceExcludedValues must still inject NOT IN on top of it.
      await safeInQk.query('todos').where('status:active').execute();
      const whereStr = getSqlString(
        mockWhere.mock.calls[0][0] as unknown as SQL
      );
      expect(whereStr).toContain('status');
      expect(whereStr.toLowerCase()).toContain('not in');
      expect(whereStr).toContain('archived');
      expect(whereStr).toContain('deleted');
    });
  });

  describe('createQueryKit with parserOptions (fixes #19)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should apply fieldMappings during query execution', async () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        parserOptions: {
          fieldMappings: { name: 'title' }
        }
      });

      await qk.query('todos').where('name:test').execute();

      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      expect(whereStr).toContain('title');
    });

    it('should apply caseInsensitiveFields during query execution', async () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        parserOptions: {
          caseInsensitiveFields: true,
          fieldMappings: { status: 'status' }
        }
      });

      await qk.query('todos').where('Status:active').execute();

      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      expect(whereStr).toContain('status');
    });

    it('should combine caseInsensitiveFields and fieldMappings', async () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        parserOptions: {
          caseInsensitiveFields: true,
          fieldMappings: { author: 'title' }
        }
      });

      await qk.query('todos').where('AUTHOR:test').execute();

      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0] as unknown as SQL;
      const whereStr = getSqlString(whereArg);
      expect(whereStr).toContain('title');
    });
  });

  describe('createQueryKit tolerant mode (fixes #19)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should auto-recover from trailing operator', async () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        tolerant: true
      });

      const results = await qk
        .query('todos')
        .where('status:active AND')
        .execute();
      expect(results).toBeDefined();
    });

    it('should auto-recover from unclosed quote', async () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        tolerant: true
      });

      const results = await qk.query('todos').where('status:"active').execute();
      expect(results).toBeDefined();
    });

    it('should parse valid queries normally in tolerant mode', async () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        tolerant: true
      });

      const results = await qk
        .query('todos')
        .where('status:active AND priority:>1')
        .execute();
      expect(results).toBeDefined();
      expect(mockWhere).toHaveBeenCalled();
    });

    it('should throw in strict mode (default)', () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } }
      });

      expect(() => qk.query('todos').where('status:active AND')).toThrow();
    });

    it('should throw when tolerant autofix also fails', () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } },
        tolerant: true
      });

      expect(() => qk.query('todos').where('')).toThrow();
    });
  });

  describe('lowercase boolean operators via createQueryKit (fixes #19)', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should execute queries with lowercase "and"', async () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } }
      });

      const results = await qk
        .query('todos')
        .where('priority:>1 and status:active')
        .execute();
      expect(results).toBeDefined();
      expect(results).toHaveLength(2);
    });

    it('should execute queries with lowercase "or"', async () => {
      const localAdapter = new DrizzleAdapter();
      localAdapter.initialize({ db: mockDb, schema: mockSchema });

      const qk = createQueryKit({
        adapter: localAdapter,
        schema: { todos: { id: {}, title: {}, priority: {}, status: {} } }
      });

      const results = await qk
        .query('todos')
        .where('status:active or status:pending')
        .execute();
      expect(results).toBeDefined();
    });
  });
});
