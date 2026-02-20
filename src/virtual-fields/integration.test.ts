/**
 * Integration test for Virtual Fields functionality
 * Demonstrates end-to-end usage with QueryKit
 */

import { createQueryKit } from '../index';
import { IQueryContext } from '../virtual-fields';
import { IAdapter, IAdapterOptions } from '../adapters/types';
import { QueryExpression } from '../parser/types';

// Mock schema for testing
type MockSchema = {
  tasks: {
    id: number;
    title: string;
    assignee_id: number;
    creator_id: number;
    status: string;
    priority: number;
  };
};

// Mock context for testing
interface ITaskContext extends IQueryContext {
  currentUserId: number;
  currentUserTeamIds: number[];
}

// Mock adapter for testing
class MockAdapter implements IAdapter {
  name = 'mock';
  private lastExpression?: QueryExpression;
  private lastTable?: string;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  initialize(_options: IAdapterOptions): void {
    // Mock initialization
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  canExecute(_expression: QueryExpression): boolean {
    return true;
  }

  async execute<T = unknown>(
    table: string,
    expression: QueryExpression
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ): Promise<T[]> {
    // Store for verification
    this.lastExpression = expression;
    this.lastTable = table;

    // Return mock data
    return [
      { id: 1, title: 'Task 1', assignee_id: 123 },
      { id: 2, title: 'Task 2', assignee_id: 123 }
    ] as T[];
  }

  getLastExpression(): QueryExpression | undefined {
    return this.lastExpression;
  }

  getLastTable(): string | undefined {
    return this.lastTable;
  }
}

describe('Virtual Fields Integration', () => {
  it('should resolve virtual fields in a complete QueryKit flow', async () => {
    const mockAdapter = new MockAdapter();

    const qk = createQueryKit<MockSchema, ITaskContext>({
      adapter: mockAdapter,
      schema: {
        tasks: {
          id: 0,
          title: '',
          assignee_id: 0,
          creator_id: 0,
          status: '',
          priority: 0
        }
      },

      virtualFields: {
        my: {
          allowedValues: ['assigned', 'created'] as const,
          resolve: (input, ctx, { fields }) => {
            const fieldMap = fields({
              assigned: 'assignee_id',
              created: 'creator_id'
            });
            return {
              type: 'comparison',
              field: fieldMap[input.value as 'assigned' | 'created'],
              operator: '==',
              value: ctx.currentUserId
            };
          }
        }
      },

      createContext: async () => ({
        currentUserId: 123,
        currentUserTeamIds: [1, 2, 3]
      })
    });

    // Execute a query with a virtual field
    const results = await qk.query('tasks').where('my:assigned').execute();

    // Verify the results
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveProperty('id', 1);

    // Verify the expression was resolved correctly
    const lastExpression = mockAdapter.getLastExpression();
    expect(lastExpression).toBeDefined();
    expect(lastExpression?.type).toBe('comparison');

    if (lastExpression?.type === 'comparison') {
      expect(lastExpression.field).toBe('assignee_id');
      expect(lastExpression.operator).toBe('==');
      expect(lastExpression.value).toBe(123);
    }
  });

  it('should resolve virtual fields combined with regular fields', async () => {
    const mockAdapter = new MockAdapter();

    const qk = createQueryKit<MockSchema, ITaskContext>({
      adapter: mockAdapter,
      schema: {
        tasks: {
          id: 0,
          title: '',
          assignee_id: 0,
          creator_id: 0,
          status: '',
          priority: 0
        }
      },

      virtualFields: {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (_input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      },

      createContext: async () => ({
        currentUserId: 456,
        currentUserTeamIds: []
      })
    });

    // Execute a query with virtual field and regular field
    await qk.query('tasks').where('my:assigned AND status:active').execute();

    // Verify the expression was resolved correctly
    const lastExpression = mockAdapter.getLastExpression();
    expect(lastExpression).toBeDefined();
    expect(lastExpression?.type).toBe('logical');

    if (lastExpression?.type === 'logical') {
      expect(lastExpression.operator).toBe('AND');

      // Check left side (virtual field resolved)
      const left = lastExpression.left;
      expect(left.type).toBe('comparison');
      if (left.type === 'comparison') {
        expect(left.field).toBe('assignee_id');
        expect(left.value).toBe(456);
      }

      // Check right side (regular field unchanged)
      const right = lastExpression.right;
      expect(right?.type).toBe('comparison');
      if (right?.type === 'comparison') {
        expect(right.field).toBe('status');
        expect(right.value).toBe('active');
      }
    }
  });

  it('should work without virtual fields configured', async () => {
    const mockAdapter = new MockAdapter();

    const qk = createQueryKit<MockSchema>({
      adapter: mockAdapter,
      schema: {
        tasks: {
          id: 0,
          title: '',
          assignee_id: 0,
          creator_id: 0,
          status: '',
          priority: 0
        }
      }
      // No virtualFields or createContext
    });

    // Execute a regular query
    const results = await qk.query('tasks').where('status:active').execute();

    expect(results).toHaveLength(2);

    // Verify the expression was not modified
    const lastExpression = mockAdapter.getLastExpression();
    expect(lastExpression?.type).toBe('comparison');
    if (lastExpression?.type === 'comparison') {
      expect(lastExpression.field).toBe('status');
      expect(lastExpression.value).toBe('active');
    }
  });

  it('should support multiple virtual fields in the same query', async () => {
    const mockAdapter = new MockAdapter();

    const qk = createQueryKit<MockSchema, ITaskContext>({
      adapter: mockAdapter,
      schema: {
        tasks: {
          id: 0,
          title: '',
          assignee_id: 0,
          creator_id: 0,
          status: '',
          priority: 0
        }
      },

      virtualFields: {
        my: {
          allowedValues: ['assigned', 'created'] as const,
          resolve: (input, ctx, { fields }) => {
            const fieldMap = fields({
              assigned: 'assignee_id',
              created: 'creator_id'
            });
            return {
              type: 'comparison',
              field: fieldMap[input.value as 'assigned' | 'created'],
              operator: '==',
              value: ctx.currentUserId
            };
          }
        }
      },

      createContext: async () => ({
        currentUserId: 789,
        currentUserTeamIds: []
      })
    });

    // Execute a query with multiple uses of the same virtual field
    await qk.query('tasks').where('my:assigned OR my:created').execute();

    // Verify both were resolved
    const lastExpression = mockAdapter.getLastExpression();
    expect(lastExpression?.type).toBe('logical');

    if (lastExpression?.type === 'logical') {
      expect(lastExpression.operator).toBe('OR');

      // Check left side (my:assigned)
      const left = lastExpression.left;
      expect(left.type).toBe('comparison');
      if (left.type === 'comparison') {
        expect(left.field).toBe('assignee_id');
        expect(left.value).toBe(789);
      }

      // Check right side (my:created)
      const right = lastExpression.right;
      expect(right?.type).toBe('comparison');
      if (right?.type === 'comparison') {
        expect(right.field).toBe('creator_id');
        expect(right.value).toBe(789);
      }
    }
  });

  it('should use fluent API methods after virtual field resolution', async () => {
    const mockAdapter = new MockAdapter();

    const qk = createQueryKit<MockSchema, ITaskContext>({
      adapter: mockAdapter,
      schema: {
        tasks: {
          id: 0,
          title: '',
          assignee_id: 0,
          creator_id: 0,
          status: '',
          priority: 0
        }
      },

      virtualFields: {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (_input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      },

      createContext: async () => ({
        currentUserId: 111,
        currentUserTeamIds: []
      })
    });

    // Execute a query with virtual field and fluent API methods
    const results = await qk
      .query('tasks')
      .where('my:assigned')
      .orderBy('priority', 'desc')
      .limit(5)
      .execute();

    expect(results).toBeDefined();
    expect(mockAdapter.getLastTable()).toBe('tasks');
  });
});
