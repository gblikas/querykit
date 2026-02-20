/**
 * Tests for Virtual Fields functionality
 */

import { QueryParseError } from '../parser/parser';
import { resolveVirtualFields } from './resolver';
import { IQueryContext, VirtualFieldsConfig } from './types';
import { IComparisonExpression, ILogicalExpression } from '../parser/types';

// Mock schema for testing
type MockSchema = {
  tasks: {
    id: number;
    title: string;
    assignee_id: number;
    creator_id: number;
    watcher_ids: number[];
    status: string;
    priority: number;
  };
  users: {
    id: number;
    name: string;
    email: string;
  };
  [key: string]: object;
};

// Mock context for testing
interface IMockContext extends IQueryContext {
  currentUserId: number;
  currentUserTeamIds: number[];
}

describe('Virtual Fields', () => {
  describe('Basic Resolution', () => {
    it('should resolve a simple virtual field to a comparison expression', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
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
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: [1, 2, 3]
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'my',
        operator: '==',
        value: 'assigned'
      };

      const resolved = resolveVirtualFields(expr, virtualFields, context);

      expect(resolved).toEqual({
        type: 'comparison',
        field: 'assignee_id',
        operator: '==',
        value: 123
      });
    });

    it('should resolve multiple different virtual fields in the same query', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        },
        team: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: 'IN',
            value: ctx.currentUserTeamIds
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: [1, 2, 3]
      };

      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'comparison',
          field: 'my',
          operator: '==',
          value: 'assigned'
        },
        right: {
          type: 'comparison',
          field: 'team',
          operator: '==',
          value: 'assigned'
        }
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.operator).toBe('OR');
      expect((resolved.left as IComparisonExpression).field).toBe(
        'assignee_id'
      );
      expect((resolved.left as IComparisonExpression).value).toBe(123);
      expect((resolved.right as IComparisonExpression).field).toBe(
        'assignee_id'
      );
      expect((resolved.right as IComparisonExpression).value).toEqual([
        1, 2, 3
      ]);
    });

    it('should resolve virtual fields combined with regular fields', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'comparison',
          field: 'my',
          operator: '==',
          value: 'assigned'
        },
        right: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'done'
        }
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.operator).toBe('AND');
      expect((resolved.left as IComparisonExpression).field).toBe(
        'assignee_id'
      );
      expect((resolved.right as IComparisonExpression).field).toBe('status');
    });

    it('should handle logical expressions with virtual fields', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
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
      };

      const context: IMockContext = {
        currentUserId: 456,
        currentUserTeamIds: []
      };

      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'comparison',
          field: 'my',
          operator: '==',
          value: 'assigned'
        },
        right: {
          type: 'comparison',
          field: 'my',
          operator: '==',
          value: 'created'
        }
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.operator).toBe('OR');
      expect((resolved.left as IComparisonExpression).field).toBe(
        'assignee_id'
      );
      expect((resolved.left as IComparisonExpression).value).toBe(456);
      expect((resolved.right as IComparisonExpression).field).toBe(
        'creator_id'
      );
      expect((resolved.right as IComparisonExpression).value).toBe(456);
    });
  });

  describe('Validation', () => {
    it('should throw QueryParseError for invalid virtual field value', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned', 'created'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'my',
        operator: '==',
        value: 'invalid_value'
      };

      expect(() => {
        resolveVirtualFields(expr, virtualFields, context);
      }).toThrow(QueryParseError);

      expect(() => {
        resolveVirtualFields(expr, virtualFields, context);
      }).toThrow(
        'Invalid value "invalid_value" for virtual field "my". Allowed values: "assigned", "created"'
      );
    });

    it('should throw QueryParseError when operators are not allowed', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          allowOperators: false, // Explicitly disallow operators
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'my',
        operator: '>',
        value: 'assigned'
      };

      expect(() => {
        resolveVirtualFields(expr, virtualFields, context);
      }).toThrow(QueryParseError);

      expect(() => {
        resolveVirtualFields(expr, virtualFields, context);
      }).toThrow('Virtual field "my" does not allow comparison operators');
    });

    it('should allow operators when allowOperators is true', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        priority: {
          allowedValues: ['high'] as const,
          allowOperators: true, // Allow operators
          resolve: input => ({
            type: 'comparison',
            field: 'priority',
            operator: input.operator as '>',
            value: 5
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'priority',
        operator: '>',
        value: 'high'
      };

      const resolved = resolveVirtualFields(expr, virtualFields, context);

      expect(resolved).toEqual({
        type: 'comparison',
        field: 'priority',
        operator: '>',
        value: 5
      });
    });

    it('should pass through unknown fields unchanged', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'done'
      };

      const resolved = resolveVirtualFields(expr, virtualFields, context);

      expect(resolved).toEqual(expr);
    });

    it('should throw QueryParseError for non-string values in virtual fields', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'my',
        operator: '==',
        value: 123 // Number instead of string
      };

      expect(() => {
        resolveVirtualFields(expr, virtualFields, context);
      }).toThrow(QueryParseError);

      expect(() => {
        resolveVirtualFields(expr, virtualFields, context);
      }).toThrow('Virtual field "my" requires a string value');
    });
  });

  describe('Context Usage', () => {
    it('should correctly use context values in resolution', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 999,
        currentUserTeamIds: []
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'my',
        operator: '==',
        value: 'assigned'
      };

      const resolved = resolveVirtualFields(expr, virtualFields, context);

      expect((resolved as IComparisonExpression).value).toBe(999);
    });

    it('should use array values from context', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        team: {
          allowedValues: ['members'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: 'IN',
            value: ctx.currentUserTeamIds
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 1,
        currentUserTeamIds: [10, 20, 30]
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'team',
        operator: '==',
        value: 'members'
      };

      const resolved = resolveVirtualFields(expr, virtualFields, context);

      expect((resolved as IComparisonExpression).value).toEqual([10, 20, 30]);
    });
  });

  describe('Complex Expressions', () => {
    it('should handle nested logical expressions with virtual fields', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'logical',
          operator: 'OR',
          left: {
            type: 'comparison',
            field: 'my',
            operator: '==',
            value: 'assigned'
          },
          right: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'done'
          }
        },
        right: {
          type: 'comparison',
          field: 'priority',
          operator: '>',
          value: 5
        }
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.operator).toBe('AND');

      const leftLogical = resolved.left as ILogicalExpression;
      expect(leftLogical.type).toBe('logical');
      expect(leftLogical.operator).toBe('OR');
      expect((leftLogical.left as IComparisonExpression).field).toBe(
        'assignee_id'
      );
    });

    it('should handle NOT operator with virtual fields', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'NOT',
        left: {
          type: 'comparison',
          field: 'my',
          operator: '==',
          value: 'assigned'
        }
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.operator).toBe('NOT');
      expect((resolved.left as IComparisonExpression).field).toBe(
        'assignee_id'
      );
    });

    it('should handle virtual field that returns a logical expression', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        myItems: {
          allowedValues: ['all'] as const,
          resolve: (input, ctx) => ({
            type: 'logical',
            operator: 'OR',
            left: {
              type: 'comparison',
              field: 'assignee_id',
              operator: '==',
              value: ctx.currentUserId
            },
            right: {
              type: 'comparison',
              field: 'creator_id',
              operator: '==',
              value: ctx.currentUserId
            }
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'myItems',
        operator: '==',
        value: 'all'
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.operator).toBe('OR');
      expect((resolved.left as IComparisonExpression).field).toBe(
        'assignee_id'
      );
      expect((resolved.right as IComparisonExpression).field).toBe(
        'creator_id'
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty virtualFields config', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {};

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'done'
      };

      const resolved = resolveVirtualFields(expr, virtualFields, context);

      expect(resolved).toEqual(expr);
    });

    it('should handle null context values', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => ({
            type: 'comparison',
            field: 'assignee_id',
            operator: '==',
            value: ctx.currentUserId ?? null
          })
        }
      };

      const context: IMockContext = {
        currentUserId: undefined as unknown as number,
        currentUserTeamIds: []
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'my',
        operator: '==',
        value: 'assigned'
      };

      const resolved = resolveVirtualFields(expr, virtualFields, context);

      // The resolver uses ?? null, so when currentUserId is undefined, it becomes null
      expect((resolved as IComparisonExpression).value).toBeNull();
    });

    it('should handle multiple values for the same virtual field', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned', 'created', 'watching'] as const,
          resolve: (input, ctx, { fields }) => {
            const fieldMap = fields({
              assigned: 'assignee_id',
              created: 'creator_id',
              watching: 'watcher_ids'
            });
            return {
              type: 'comparison',
              field:
                fieldMap[input.value as 'assigned' | 'created' | 'watching'],
              operator: '==',
              value: ctx.currentUserId
            };
          }
        }
      };

      const context: IMockContext = {
        currentUserId: 123,
        currentUserTeamIds: []
      };

      // Test each allowed value
      const values = ['assigned', 'created', 'watching'] as const;
      const expectedFields = ['assignee_id', 'creator_id', 'watcher_ids'];

      values.forEach((value, index) => {
        const expr: IComparisonExpression = {
          type: 'comparison',
          field: 'my',
          operator: '==',
          value: value
        };

        const resolved = resolveVirtualFields(expr, virtualFields, context);

        expect((resolved as IComparisonExpression).field).toBe(
          expectedFields[index]
        );
      });
    });
  });

  describe('Type Safety (Documented)', () => {
    it('documents that fields() helper provides compile-time validation', () => {
      // This test documents the type-safety feature.
      // The actual validation happens at compile-time via TypeScript.

      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned', 'created'] as const,
          resolve: (input, ctx, { fields }) => {
            // TypeScript validates that all keys in allowedValues are mapped
            // and all values are valid schema fields
            const fieldMap = fields({
              assigned: 'assignee_id',
              created: 'creator_id'
            });

            // This would cause a TypeScript error if uncommented:
            // const badMap = fields({
            //   assigned: 'invalid_field' // Error: not a valid schema field
            // });

            // This would also cause a TypeScript error:
            // const incompleteMap = fields({
            //   assigned: 'assignee_id'
            //   // Missing 'created' key
            // });

            return {
              type: 'comparison',
              field: fieldMap[input.value as 'assigned' | 'created'],
              operator: '==',
              value: ctx.currentUserId
            };
          }
        }
      };

      // The fields() helper is an identity function at runtime
      expect(typeof virtualFields.my.resolve).toBe('function');
    });
  });
});
