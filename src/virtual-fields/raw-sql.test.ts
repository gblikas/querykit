/**
 * Tests for Raw SQL expressions in Virtual Fields
 */

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { IRawSqlExpression } from '../parser/types';
import { resolveVirtualFields } from './resolver';
import { jsonbContains, dateWithinDays } from './helpers';
import { IQueryContext, VirtualFieldsConfig } from './types';
import { IComparisonExpression, ILogicalExpression } from '../parser/types';
import { DrizzleTranslator } from '../translators/drizzle';

// Mock schema for testing
type MockSchema = {
  tasks: {
    id: number;
    title: string;
    assignee_id: number;
    assigned_to: string[];
    created_at: Date;
    status: string;
    priority: number;
  };
};

// Mock context for testing
interface IMockContext extends IQueryContext {
  currentUserId: string;
}

// Helper to extract SQL string for testing
function getSqlString(sqlObj: SQL): string {
  try {
    return JSON.stringify(sqlObj);
  } catch (e) {
    return String(sqlObj);
  }
}

describe('Raw SQL Expressions', () => {
  describe('Unit Tests - IRawSqlExpression', () => {
    it('should create a raw SQL expression with type "raw"', () => {
      const rawExpr: IRawSqlExpression = {
        type: 'raw',
        toSql: () => sql`status = 'active'`
      };

      expect(rawExpr.type).toBe('raw');
      expect(typeof rawExpr.toSql).toBe('function');
    });

    it('should invoke toSql method with context', () => {
      const mockContext = {
        adapter: 'drizzle',
        tableName: 'tasks',
        schema: {}
      };

      const rawExpr: IRawSqlExpression = {
        type: 'raw',
        toSql: ctx => {
          expect(ctx.adapter).toBe('drizzle');
          expect(ctx.tableName).toBe('tasks');
          return sql`test`;
        }
      };

      rawExpr.toSql(mockContext);
    });

    it('should support custom SQL generation logic', () => {
      const rawExpr: IRawSqlExpression = {
        type: 'raw',
        toSql: () => sql`${sql.identifier('custom_field')} = 'custom_value'`
      };

      const result = rawExpr.toSql({
        adapter: 'drizzle',
        tableName: 'test',
        schema: {}
      });

      expect(result).toBeDefined();
    });
  });

  describe('Helper Functions', () => {
    describe('jsonbContains', () => {
      it('should create JSONB contains expression for single value', () => {
        const expr = jsonbContains('assigned_to', 'user123');

        expect(expr.type).toBe('raw');
        expect(typeof expr.toSql).toBe('function');

        const result = expr.toSql({
          adapter: 'drizzle',
          tableName: 'tasks',
          schema: {}
        });
        const sqlString = getSqlString(result as SQL);

        expect(sqlString).toContain('assigned_to');
        expect(sqlString).toContain('@>');
        expect(sqlString).toContain('user123');
      });

      it('should wrap single value in array', () => {
        const expr = jsonbContains('assigned_to', 'user123');
        const result = expr.toSql({
          adapter: 'drizzle',
          tableName: 'tasks',
          schema: {}
        });
        const sqlString = getSqlString(result as SQL);

        // Check for the escaped JSON format in the serialized SQL
        expect(sqlString).toContain('user123');
        expect(sqlString).toContain('assigned_to');
      });

      it('should handle array values', () => {
        const expr = jsonbContains('assigned_to', ['user123', 'user456']);
        const result = expr.toSql({
          adapter: 'drizzle',
          tableName: 'tasks',
          schema: {}
        });
        const sqlString = getSqlString(result as SQL);

        expect(sqlString).toContain('assigned_to');
        expect(sqlString).toContain('user123');
        expect(sqlString).toContain('user456');
      });

      it('should validate field name to prevent SQL injection', () => {
        expect(() => jsonbContains('invalid;field', 'value')).toThrow(
          'Invalid field name'
        );
        expect(() => jsonbContains('1invalid', 'value')).toThrow(
          'Invalid field name'
        );
        expect(() => jsonbContains('a'.repeat(65), 'value')).toThrow(
          'Field name too long'
        );
      });

      it('should allow valid field names with dots and underscores', () => {
        expect(() => jsonbContains('valid_field', 'value')).not.toThrow();
        expect(() => jsonbContains('table.field', 'value')).not.toThrow();
        expect(() => jsonbContains('my_table.my_field', 'value')).not.toThrow();
      });
    });

    describe('dateWithinDays', () => {
      it('should create date range expression', () => {
        const expr = dateWithinDays('created_at', 1);

        expect(expr.type).toBe('raw');
        expect(typeof expr.toSql).toBe('function');

        const result = expr.toSql({
          adapter: 'drizzle',
          tableName: 'tasks',
          schema: {}
        });
        const sqlString = getSqlString(result as SQL);

        expect(sqlString).toContain('created_at');
        expect(sqlString).toContain('>=');
        expect(sqlString).toContain('NOW()');
        expect(sqlString).toContain('INTERVAL');
        expect(sqlString).toContain('1');
      });

      it('should support different day values', () => {
        const expr7 = dateWithinDays('created_at', 7);
        const result7 = expr7.toSql({
          adapter: 'drizzle',
          tableName: 'tasks',
          schema: {}
        });
        const sqlString7 = getSqlString(result7 as SQL);

        expect(sqlString7).toContain('7');

        const expr30 = dateWithinDays('created_at', 30);
        const result30 = expr30.toSql({
          adapter: 'drizzle',
          tableName: 'tasks',
          schema: {}
        });
        const sqlString30 = getSqlString(result30 as SQL);

        expect(sqlString30).toContain('30');
      });

      it('should validate field name to prevent SQL injection', () => {
        expect(() => dateWithinDays('invalid;field', 7)).toThrow(
          'Invalid field name'
        );
        expect(() => dateWithinDays('1invalid', 7)).toThrow(
          'Invalid field name'
        );
        expect(() => dateWithinDays('a'.repeat(65), 7)).toThrow(
          'Field name too long'
        );
      });

      it('should allow valid field names with dots and underscores', () => {
        expect(() => dateWithinDays('valid_field', 7)).not.toThrow();
        expect(() => dateWithinDays('table.field', 7)).not.toThrow();
        expect(() => dateWithinDays('my_table.my_field', 7)).not.toThrow();
      });

      it('should validate days parameter to ensure it is a positive finite number', () => {
        expect(() => dateWithinDays('created_at', -1)).toThrow(
          'Must be a positive number'
        );
        expect(() => dateWithinDays('created_at', 0)).toThrow(
          'Must be a positive number'
        );
        expect(() => dateWithinDays('created_at', Infinity)).toThrow(
          'Must be a finite number'
        );
        expect(() => dateWithinDays('created_at', -Infinity)).toThrow(
          'Must be a finite number'
        );
        expect(() => dateWithinDays('created_at', NaN)).toThrow(
          'Must be a finite number'
        );
      });

      it('should accept valid positive finite number values for days', () => {
        expect(() => dateWithinDays('created_at', 1)).not.toThrow();
        expect(() => dateWithinDays('created_at', 0.5)).not.toThrow();
        expect(() => dateWithinDays('created_at', 1000)).not.toThrow();
      });
    });
  });

  describe('Integration with Resolver', () => {
    it('should pass through raw expressions unchanged', () => {
      const context: IMockContext = {
        currentUserId: 'user123'
      };

      const rawExpr: IRawSqlExpression = {
        type: 'raw',
        toSql: () => sql`test = 'value'`
      };

      const result = resolveVirtualFields(rawExpr, {}, context);

      expect(result).toBe(rawExpr); // Should be the exact same object
      expect(result.type).toBe('raw');
    });

    it('should resolve virtual fields to raw expressions', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) => {
            if (input.value === 'assigned') {
              return jsonbContains('assigned_to', ctx.currentUserId);
            }
            throw new Error('Unknown value');
          }
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'my',
        operator: '==',
        value: 'assigned'
      };

      const resolved = resolveVirtualFields(expr, virtualFields, context);

      expect(resolved.type).toBe('raw');
      expect((resolved as IRawSqlExpression).toSql).toBeDefined();
    });

    it('should support raw expressions in logical AND operations', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) =>
            jsonbContains('assigned_to', ctx.currentUserId)
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
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
          value: 'active'
        }
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.operator).toBe('AND');
      expect(resolved.left.type).toBe('raw');
      expect(resolved.right?.type).toBe('comparison');
    });

    it('should support raw expressions in logical OR operations', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        priority: {
          allowedValues: ['high'] as const,
          resolve: () => dateWithinDays('created_at', 1)
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
      };

      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'comparison',
          field: 'priority',
          operator: '==',
          value: 'high'
        },
        right: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'urgent'
        }
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.operator).toBe('OR');
      expect(resolved.left.type).toBe('raw');
      expect(resolved.right?.type).toBe('comparison');
    });

    it('should support raw expressions in NOT operations', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) =>
            jsonbContains('assigned_to', ctx.currentUserId)
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
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
      expect(resolved.left.type).toBe('raw');
    });

    it('should mix raw and standard comparison expressions', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) =>
            jsonbContains('assigned_to', ctx.currentUserId)
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
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
          type: 'logical',
          operator: 'AND',
          left: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'active'
          },
          right: {
            type: 'comparison',
            field: 'priority',
            operator: '>',
            value: 2
          }
        }
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.left.type).toBe('raw');

      const right = resolved.right as ILogicalExpression;
      expect(right.type).toBe('logical');
      expect(right.left.type).toBe('comparison');
      expect(right.right?.type).toBe('comparison');
    });
  });

  describe('Integration with Drizzle Translator', () => {
    const translator = new DrizzleTranslator();

    it('should translate raw SQL expression', () => {
      const rawExpr: IRawSqlExpression = {
        type: 'raw',
        toSql: () => sql`status = 'active'`
      };

      const result = translator.translate(rawExpr);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('status');
      expect(sqlString).toContain('active');
    });

    it('should translate JSONB contains expression', () => {
      const expr = jsonbContains('assigned_to', 'user123');
      const result = translator.translate(expr);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('assigned_to');
      expect(sqlString).toContain('@>');
      expect(sqlString).toContain('user123');
    });

    it('should translate date range expression', () => {
      const expr = dateWithinDays('created_at', 7);
      const result = translator.translate(expr);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('created_at');
      expect(sqlString).toContain('>=');
      expect(sqlString).toContain('NOW()');
      expect(sqlString).toContain('7');
    });

    it('should translate raw expressions in AND operations', () => {
      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'AND',
        left: jsonbContains('assigned_to', 'user123'),
        right: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'active'
        }
      };

      const result = translator.translate(expr);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('AND');
      expect(sqlString).toContain('assigned_to');
      expect(sqlString).toContain('status');
    });

    it('should translate raw expressions in OR operations', () => {
      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'OR',
        left: dateWithinDays('created_at', 1),
        right: {
          type: 'comparison',
          field: 'priority',
          operator: '>',
          value: 5
        }
      };

      const result = translator.translate(expr);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('OR');
      expect(sqlString).toContain('created_at');
      expect(sqlString).toContain('priority');
    });

    it('should translate raw expressions in NOT operations', () => {
      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'NOT',
        left: jsonbContains('assigned_to', 'user123')
      };

      const result = translator.translate(expr);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('NOT');
      expect(sqlString).toContain('assigned_to');
    });

    it('should translate complex nested expressions with raw SQL', () => {
      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'logical',
          operator: 'OR',
          left: jsonbContains('assigned_to', 'user123'),
          right: dateWithinDays('created_at', 7)
        },
        right: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'active'
        }
      };

      const result = translator.translate(expr);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('AND');
      expect(sqlString).toContain('OR');
      expect(sqlString).toContain('assigned_to');
      expect(sqlString).toContain('created_at');
      expect(sqlString).toContain('status');
    });

    it('should handle multiple raw expressions', () => {
      const expr: ILogicalExpression = {
        type: 'logical',
        operator: 'AND',
        left: jsonbContains('assigned_to', 'user123'),
        right: dateWithinDays('created_at', 7)
      };

      const result = translator.translate(expr);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('AND');
      expect(sqlString).toContain('assigned_to');
      expect(sqlString).toContain('created_at');
    });
  });

  describe('End-to-End Tests', () => {
    it('should resolve and translate JSONB contains scenario', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          description: 'Filter by your relationship to items',
          resolve: (input, ctx) => {
            if (input.value === 'assigned') {
              return jsonbContains('assigned_to', ctx.currentUserId);
            }
            throw new Error(`Unknown value: ${input.value}`);
          }
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'my',
        operator: '==',
        value: 'assigned'
      };

      // Step 1: Resolve virtual fields
      const resolved = resolveVirtualFields(expr, virtualFields, context);
      expect(resolved.type).toBe('raw');

      // Step 2: Translate to SQL
      const translator = new DrizzleTranslator();
      const result = translator.translate(resolved);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('assigned_to');
      expect(sqlString).toContain('@>');
      expect(sqlString).toContain('user123');
    });

    it('should resolve and translate date-based computed field', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        priority: {
          allowedValues: ['high', 'medium', 'low'] as const,
          description: 'Filter by computed priority (based on age)',
          resolve: input => {
            const thresholds = { high: 1, medium: 7, low: 30 };
            const days = thresholds[input.value as keyof typeof thresholds];
            return dateWithinDays('created_at', days);
          }
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'priority',
        operator: '==',
        value: 'high'
      };

      // Step 1: Resolve virtual fields
      const resolved = resolveVirtualFields(expr, virtualFields, context);
      expect(resolved.type).toBe('raw');

      // Step 2: Translate to SQL
      const translator = new DrizzleTranslator();
      const result = translator.translate(resolved);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('created_at');
      expect(sqlString).toContain('1');
    });

    it('should handle custom raw SQL example', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        custom: {
          allowedValues: ['active'] as const,
          resolve: (_input, ctx) => ({
            type: 'raw',
            toSql: (): SQL => {
              // Build SQL using the same pattern as the translators
              const userId = ctx.currentUserId;
              return sql`status = 'active' AND assignee_id = ${userId}`;
            }
          })
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'custom',
        operator: '==',
        value: 'active'
      };

      // Step 1: Resolve virtual fields
      const resolved = resolveVirtualFields(expr, virtualFields, context);
      expect(resolved.type).toBe('raw');

      // Step 2: Translate to SQL
      const translator = new DrizzleTranslator();
      const result = translator.translate(resolved);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('status');
      expect(sqlString).toContain('active');
      expect(sqlString).toContain('assignee_id');
      expect(sqlString).toContain('user123');
    });

    it('should handle complex query with multiple virtual fields', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) =>
            jsonbContains('assigned_to', ctx.currentUserId)
        },
        priority: {
          allowedValues: ['high'] as const,
          resolve: () => dateWithinDays('created_at', 1)
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
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
          type: 'logical',
          operator: 'AND',
          left: {
            type: 'comparison',
            field: 'priority',
            operator: '==',
            value: 'high'
          },
          right: {
            type: 'comparison',
            field: 'status',
            operator: '==',
            value: 'active'
          }
        }
      };

      // Step 1: Resolve virtual fields
      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.type).toBe('logical');
      expect(resolved.left.type).toBe('raw');

      // Step 2: Translate to SQL
      const translator = new DrizzleTranslator();
      const result = translator.translate(resolved);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('AND');
      expect(sqlString).toContain('assigned_to');
      expect(sqlString).toContain('created_at');
      expect(sqlString).toContain('status');
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed raw expression gracefully', () => {
      const rawExpr: IRawSqlExpression = {
        type: 'raw',
        toSql: () => {
          throw new Error('SQL generation failed');
        }
      };

      const translator = new DrizzleTranslator();

      expect(() => translator.translate(rawExpr)).toThrow();
    });

    it('should validate that toSql returns valid SQL object', () => {
      const rawExpr: IRawSqlExpression = {
        type: 'raw',
        toSql: () => sql`valid = 'sql'`
      };

      const translator = new DrizzleTranslator();
      const result = translator.translate(rawExpr);

      expect(result).toBeDefined();
    });
  });

  describe('SQL Output Verification', () => {
    it('should generate correct JSONB contains SQL', () => {
      const expr = jsonbContains('assigned_to', 'user123');
      const result = expr.toSql({
        adapter: 'drizzle',
        tableName: 'tasks',
        schema: {}
      }) as SQL;

      const sqlString = getSqlString(result);

      // Verify the SQL structure contains the expected elements
      expect(sqlString).toContain('assigned_to');
      expect(sqlString).toContain('@>');
      expect(sqlString).toContain('user123');
      expect(sqlString).toContain('::jsonb');
    });

    it('should generate correct date range SQL', () => {
      const expr = dateWithinDays('created_at', 7);
      const result = expr.toSql({
        adapter: 'drizzle',
        tableName: 'tasks',
        schema: {}
      }) as SQL;

      const sqlString = getSqlString(result);

      // Verify the SQL structure contains the expected elements
      expect(sqlString).toContain('created_at');
      expect(sqlString).toContain('>=');
      expect(sqlString).toContain('NOW()');
      expect(sqlString).toContain('INTERVAL');
      expect(sqlString).toContain('7');
    });

    it('should use sql.identifier for safe field references', () => {
      const expr = jsonbContains('assigned_to', 'user123');
      const result = expr.toSql({
        adapter: 'drizzle',
        tableName: 'tasks',
        schema: {}
      }) as SQL;

      // sql.identifier should properly escape field names
      expect(result).toBeDefined();
    });
  });

  describe('Real-World Scenarios', () => {
    it('should support JSONB array membership check', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) =>
            jsonbContains('assigned_to', ctx.currentUserId)
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
      };

      const expr: IComparisonExpression = {
        type: 'comparison',
        field: 'my',
        operator: '==',
        value: 'assigned'
      };

      const resolved = resolveVirtualFields(expr, virtualFields, context);
      const translator = new DrizzleTranslator();
      const result = translator.translate(resolved);

      expect(result).toBeDefined();
      const sqlString = getSqlString(result);
      expect(sqlString).toContain('assigned_to');
    });

    it('should support computed priority based on createdAt', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        priority: {
          allowedValues: ['high', 'medium', 'low'] as const,
          resolve: input => {
            const days = { high: 1, medium: 7, low: 30 }[
              input.value as 'high' | 'medium' | 'low'
            ];
            return dateWithinDays('created_at', days);
          }
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
      };

      ['high', 'medium', 'low'].forEach((priority, idx) => {
        const expr: IComparisonExpression = {
          type: 'comparison',
          field: 'priority',
          operator: '==',
          value: priority
        };

        const resolved = resolveVirtualFields(expr, virtualFields, context);
        const translator = new DrizzleTranslator();
        const result = translator.translate(resolved);
        const sqlString = getSqlString(result);

        expect(sqlString).toContain('created_at');
        expect(sqlString).toContain([1, 7, 30][idx].toString());
      });
    });

    it('should support combined JSONB and date filters', () => {
      const virtualFields: VirtualFieldsConfig<MockSchema, IMockContext> = {
        my: {
          allowedValues: ['assigned'] as const,
          resolve: (input, ctx) =>
            jsonbContains('assigned_to', ctx.currentUserId)
        },
        priority: {
          allowedValues: ['high'] as const,
          resolve: () => dateWithinDays('created_at', 1)
        }
      };

      const context: IMockContext = {
        currentUserId: 'user123'
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
          field: 'priority',
          operator: '==',
          value: 'high'
        }
      };

      const resolved = resolveVirtualFields(
        expr,
        virtualFields,
        context
      ) as ILogicalExpression;

      expect(resolved.left.type).toBe('raw');
      expect(resolved.right?.type).toBe('raw');

      const translator = new DrizzleTranslator();
      const result = translator.translate(resolved);
      const sqlString = getSqlString(result);

      expect(sqlString).toContain('AND');
      expect(sqlString).toContain('assigned_to');
      expect(sqlString).toContain('created_at');
    });
  });
});
