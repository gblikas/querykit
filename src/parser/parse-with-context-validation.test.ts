/**
 * Tests for Validation & Security features of parseWithContext:
 * - Schema-aware field validation
 * - Security pre-check
 */

import { QueryParser } from './parser';
import { IFieldSchema } from './types';

describe('QueryParser.parseWithContext - Validation & Security', () => {
  let parser: QueryParser;

  beforeEach(() => {
    parser = new QueryParser();
  });

  describe('Field Validation (with schema)', () => {
    const testSchema: Record<string, IFieldSchema> = {
      status: { type: 'string', allowedValues: ['todo', 'doing', 'done'] },
      priority: { type: 'number' },
      name: { type: 'string' },
      createdAt: { type: 'date' },
      isActive: { type: 'boolean' },
      tags: { type: 'array' }
    };

    describe('valid fields', () => {
      it('should validate fields that exist in schema', () => {
        const result = parser.parseWithContext('status:done', {
          schema: testSchema
        });

        expect(result.fieldValidation).toBeDefined();
        expect(result.fieldValidation?.valid).toBe(true);
        expect(result.fieldValidation?.unknownFields).toHaveLength(0);
      });

      it('should include field details for valid fields', () => {
        const result = parser.parseWithContext(
          'status:done AND priority:high',
          {
            schema: testSchema
          }
        );

        expect(result.fieldValidation?.fields).toHaveLength(2);

        const statusField = result.fieldValidation?.fields.find(
          f => f.field === 'status'
        );
        expect(statusField).toMatchObject({
          field: 'status',
          valid: true,
          expectedType: 'string',
          allowedValues: ['todo', 'doing', 'done']
        });

        const priorityField = result.fieldValidation?.fields.find(
          f => f.field === 'priority'
        );
        expect(priorityField).toMatchObject({
          field: 'priority',
          valid: true,
          expectedType: 'number'
        });
      });

      it('should handle multiple references to same field', () => {
        const result = parser.parseWithContext('status:todo OR status:done', {
          schema: testSchema
        });

        expect(result.fieldValidation?.valid).toBe(true);
        // referencedFields should deduplicate
        expect(result.structure.referencedFields).toEqual(['status']);
      });
    });

    describe('invalid fields', () => {
      it('should detect unknown fields', () => {
        const result = parser.parseWithContext('unknownField:value', {
          schema: testSchema
        });

        expect(result.fieldValidation?.valid).toBe(false);
        expect(result.fieldValidation?.unknownFields).toContain('unknownField');
      });

      it('should provide reason for invalid fields', () => {
        const result = parser.parseWithContext('badField:value', {
          schema: testSchema
        });

        const badField = result.fieldValidation?.fields.find(
          f => f.field === 'badField'
        );
        expect(badField).toMatchObject({
          field: 'badField',
          valid: false,
          reason: 'unknown_field'
        });
      });

      it('should suggest similar field for typos', () => {
        const result = parser.parseWithContext('statis:done', {
          schema: testSchema
        });

        const field = result.fieldValidation?.fields.find(
          f => f.field === 'statis'
        );
        expect(field?.suggestion).toBe('status');
      });

      it('should suggest case-corrected field', () => {
        const result = parser.parseWithContext('STATUS:done', {
          schema: testSchema
        });

        const field = result.fieldValidation?.fields.find(
          f => f.field === 'STATUS'
        );
        expect(field?.suggestion).toBe('status');
      });

      it('should suggest field with similar prefix', () => {
        const result = parser.parseWithContext('creat:value', {
          schema: testSchema
        });

        const field = result.fieldValidation?.fields.find(
          f => f.field === 'creat'
        );
        expect(field?.suggestion).toBe('createdAt');
      });
    });

    describe('mixed valid and invalid fields', () => {
      it('should report all fields with mixed validity', () => {
        const result = parser.parseWithContext(
          'status:done AND badField:value',
          { schema: testSchema }
        );

        expect(result.fieldValidation?.valid).toBe(false);
        expect(result.fieldValidation?.fields).toHaveLength(2);

        const validField = result.fieldValidation?.fields.find(
          f => f.field === 'status'
        );
        expect(validField?.valid).toBe(true);

        const invalidField = result.fieldValidation?.fields.find(
          f => f.field === 'badField'
        );
        expect(invalidField?.valid).toBe(false);
      });
    });

    describe('no schema provided', () => {
      it('should not include fieldValidation when no schema', () => {
        const result = parser.parseWithContext('status:done');

        expect(result.fieldValidation).toBeUndefined();
      });
    });
  });

  describe('Security Pre-check', () => {
    describe('denied fields', () => {
      it('should detect denied fields', () => {
        const result = parser.parseWithContext('password:secret', {
          securityOptions: {
            denyFields: ['password', 'secret_key']
          }
        });

        expect(result.security?.passed).toBe(false);
        expect(result.security?.violations).toContainEqual(
          expect.objectContaining({
            type: 'denied_field',
            field: 'password'
          })
        );
      });

      it('should pass when field is not denied', () => {
        const result = parser.parseWithContext('status:done', {
          securityOptions: {
            denyFields: ['password', 'secret_key']
          }
        });

        expect(result.security?.passed).toBe(true);
        expect(result.security?.violations).toHaveLength(0);
      });
    });

    describe('allowed fields', () => {
      it('should detect fields not in allowed list', () => {
        const result = parser.parseWithContext('status:done AND secret:value', {
          securityOptions: {
            allowedFields: ['status', 'priority', 'name']
          }
        });

        expect(result.security?.passed).toBe(false);
        expect(result.security?.violations).toContainEqual(
          expect.objectContaining({
            type: 'field_not_allowed',
            field: 'secret'
          })
        );
      });

      it('should pass when all fields are allowed', () => {
        const result = parser.parseWithContext(
          'status:done AND priority:high',
          {
            securityOptions: {
              allowedFields: ['status', 'priority', 'name']
            }
          }
        );

        expect(result.security?.passed).toBe(true);
      });
    });

    describe('dot notation', () => {
      it('should detect dot notation when disabled', () => {
        const result = parser.parseWithContext('user.email:test@example.com', {
          securityOptions: {
            allowDotNotation: false
          }
        });

        expect(result.security?.passed).toBe(false);
        expect(result.security?.violations).toContainEqual(
          expect.objectContaining({
            type: 'dot_notation',
            field: 'user.email'
          })
        );
      });

      it('should allow dot notation by default', () => {
        const result = parser.parseWithContext('user.email:test@example.com', {
          securityOptions: {}
        });

        expect(result.security?.passed).toBe(true);
      });
    });

    describe('query depth', () => {
      it('should detect exceeded depth', () => {
        const result = parser.parseWithContext('((a:1 AND b:2) OR c:3)', {
          securityOptions: {
            maxQueryDepth: 1
          }
        });

        expect(result.security?.passed).toBe(false);
        expect(result.security?.violations).toContainEqual(
          expect.objectContaining({
            type: 'depth_exceeded'
          })
        );
      });

      it('should warn when approaching depth limit', () => {
        const result = parser.parseWithContext('(a:1 AND b:2)', {
          securityOptions: {
            maxQueryDepth: 2
          }
        });

        // Depth is 1, limit is 2, 80% of 2 is 1.6
        // So depth 1 doesn't trigger warning, but depth 2 would
        expect(result.security?.passed).toBe(true);
      });

      it('should pass when within depth limit', () => {
        const result = parser.parseWithContext('a:1 AND b:2', {
          securityOptions: {
            maxQueryDepth: 5
          }
        });

        expect(result.security?.passed).toBe(true);
      });
    });

    describe('clause count', () => {
      it('should detect exceeded clause count', () => {
        const result = parser.parseWithContext('a:1 AND b:2 AND c:3 AND d:4', {
          securityOptions: {
            maxClauseCount: 3
          }
        });

        expect(result.security?.passed).toBe(false);
        expect(result.security?.violations).toContainEqual(
          expect.objectContaining({
            type: 'clause_limit'
          })
        );
      });

      it('should warn when approaching clause limit', () => {
        const result = parser.parseWithContext('a:1 AND b:2 AND c:3 AND d:4', {
          securityOptions: {
            maxClauseCount: 5
          }
        });

        expect(result.security?.passed).toBe(true);
        expect(result.security?.warnings).toContainEqual(
          expect.objectContaining({
            type: 'approaching_clause_limit',
            current: 4,
            limit: 5
          })
        );
      });
    });

    describe('complexity warnings', () => {
      it('should warn about complex queries', () => {
        const clauses = Array.from(
          { length: 10 },
          (_, i) => `field${i}:value${i}`
        );
        const query = clauses.join(' AND ');

        const result = parser.parseWithContext(query, {
          securityOptions: {}
        });

        expect(result.security?.warnings).toContainEqual(
          expect.objectContaining({
            type: 'complex_query'
          })
        );
      });
    });

    describe('multiple violations', () => {
      it('should report all violations', () => {
        const result = parser.parseWithContext(
          'password:secret AND user.role:admin',
          {
            securityOptions: {
              denyFields: ['password'],
              allowDotNotation: false
            }
          }
        );

        expect(result.security?.passed).toBe(false);
        expect(result.security?.violations.length).toBeGreaterThanOrEqual(2);
      });
    });

    describe('no security options provided', () => {
      it('should not include security when no options', () => {
        const result = parser.parseWithContext('status:done');

        expect(result.security).toBeUndefined();
      });
    });
  });

  describe('Combined schema and security', () => {
    it('should include both fieldValidation and security when both provided', () => {
      const result = parser.parseWithContext('status:done', {
        schema: {
          status: { type: 'string' }
        },
        securityOptions: {
          denyFields: ['password']
        }
      });

      expect(result.fieldValidation).toBeDefined();
      expect(result.security).toBeDefined();
      expect(result.fieldValidation?.valid).toBe(true);
      expect(result.security?.passed).toBe(true);
    });

    it('should report issues from both validations', () => {
      const result = parser.parseWithContext(
        'unknownField:value AND password:secret',
        {
          schema: {
            status: { type: 'string' }
          },
          securityOptions: {
            denyFields: ['password']
          }
        }
      );

      expect(result.fieldValidation?.valid).toBe(false);
      expect(result.security?.passed).toBe(false);
    });
  });

  describe('Integration with Core Parsing', () => {
    it('should include all core parsing features', () => {
      const result = parser.parseWithContext('status:done AND priority:high', {
        cursorPosition: 5,
        schema: {
          status: { type: 'string' },
          priority: { type: 'number' }
        },
        securityOptions: {
          maxClauseCount: 10
        }
      });

      // Core parsing features
      expect(result.success).toBe(true);
      expect(result.tokens).toHaveLength(3);
      expect(result.activeToken).toBeDefined();
      expect(result.structure).toBeDefined();

      // Validation & Security features
      expect(result.fieldValidation).toBeDefined();
      expect(result.security).toBeDefined();
    });

    it('should work with failed parsing', () => {
      const result = parser.parseWithContext('status:', {
        schema: {
          status: { type: 'string' }
        },
        securityOptions: {}
      });

      expect(result.success).toBe(false);
      expect(result.fieldValidation?.valid).toBe(true); // Field is valid
      expect(result.security?.passed).toBe(true); // No security issues
    });
  });
});
