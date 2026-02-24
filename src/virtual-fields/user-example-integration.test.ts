/**
 * End-to-end integration test demonstrating the user's example from the issue
 */

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { jsonbContains, dateWithinDays } from '../virtual-fields';
import { QueryParser } from '../parser';
import { resolveVirtualFields } from '../virtual-fields/resolver';
import { IQueryContext, VirtualFieldsConfig } from '../virtual-fields/types';
import { DrizzleTranslator } from '../translators/drizzle';

// Mock schema similar to the user's example
type UserSchema = {
  my_table: {
    id: number;
    title: string;
    description: string;
    created_at: Date;
    assigned_to: string[];
    status: string;
  };
};

interface IMyContext extends IQueryContext {
  currentUserId: string;
}

describe('Raw SQL Expression - User Example Integration', () => {
  it('should parse and resolve my:assigned JSONB query from user example', () => {
    const parser = new QueryParser();
    const translator = new DrizzleTranslator();

    const virtualFields: VirtualFieldsConfig<UserSchema, IMyContext> = {
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

    const context: IMyContext = { currentUserId: 'user123' };

    // Parse the query
    const expr = parser.parse('my:assigned');
    expect(expr.type).toBe('comparison');

    // Resolve virtual fields
    const resolved = resolveVirtualFields(expr, virtualFields, context);
    expect(resolved.type).toBe('raw');

    // Translate to SQL
    const result = translator.translate(resolved);
    expect(result).toBeDefined();

    // Verify SQL contains expected elements
    const sqlString = JSON.stringify(result);
    expect(sqlString).toContain('assigned_to');
    expect(sqlString).toContain('user123');
  });

  it('should parse and resolve priority:high computed field from user example', () => {
    const parser = new QueryParser();
    const translator = new DrizzleTranslator();

    const virtualFields: VirtualFieldsConfig<UserSchema, IMyContext> = {
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

    const context: IMyContext = { currentUserId: 'user123' };

    // Parse the query
    const expr = parser.parse('priority:high');
    expect(expr.type).toBe('comparison');

    // Resolve virtual fields
    const resolved = resolveVirtualFields(expr, virtualFields, context);
    expect(resolved.type).toBe('raw');

    // Translate to SQL
    const result = translator.translate(resolved);
    expect(result).toBeDefined();

    // Verify SQL contains expected elements
    const sqlString = JSON.stringify(result);
    expect(sqlString).toContain('created_at');
    expect(sqlString).toContain('1');
  });

  it('should handle combined query: my:assigned AND priority:high AND status:active', () => {
    const parser = new QueryParser();
    const translator = new DrizzleTranslator();

    const virtualFields: VirtualFieldsConfig<UserSchema, IMyContext> = {
      my: {
        allowedValues: ['assigned'] as const,
        resolve: (input, ctx) => jsonbContains('assigned_to', ctx.currentUserId)
      },
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

    const context: IMyContext = { currentUserId: 'user123' };

    // Parse the combined query
    const expr = parser.parse(
      'my:assigned AND priority:high AND status:active'
    );
    expect(expr.type).toBe('logical');

    // Resolve virtual fields
    const resolved = resolveVirtualFields(expr, virtualFields, context);
    expect(resolved.type).toBe('logical');

    // Translate to SQL
    const result = translator.translate(resolved);
    expect(result).toBeDefined();

    // Verify SQL contains all expected elements
    const sqlString = JSON.stringify(result);
    expect(sqlString).toContain('assigned_to');
    expect(sqlString).toContain('created_at');
    expect(sqlString).toContain('status');
    expect(sqlString).toContain('AND');
  });

  it('should support custom raw SQL as shown in user example', () => {
    const parser = new QueryParser();
    const translator = new DrizzleTranslator();

    const virtualFields: VirtualFieldsConfig<UserSchema, IMyContext> = {
      custom: {
        allowedValues: ['active'] as const,
        resolve: (_input, ctx) => ({
          type: 'raw',
          toSql: (): SQL =>
            sql`status = 'active' AND owner_id = ${ctx.currentUserId}`
        })
      }
    };

    const context: IMyContext = { currentUserId: 'user123' };

    // Parse the query
    const expr = parser.parse('custom:active');
    expect(expr.type).toBe('comparison');

    // Resolve virtual fields
    const resolved = resolveVirtualFields(expr, virtualFields, context);
    expect(resolved.type).toBe('raw');

    // Translate to SQL
    const result = translator.translate(resolved);
    expect(result).toBeDefined();

    // Verify SQL contains expected elements
    const sqlString = JSON.stringify(result);
    expect(sqlString).toContain('status');
    expect(sqlString).toContain('active');
    expect(sqlString).toContain('user123');
  });
});
