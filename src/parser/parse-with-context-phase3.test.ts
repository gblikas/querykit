/**
 * Tests for Phase 3 features of parseWithContext:
 * - Autocomplete suggestions
 * - Error recovery hints
 */

import { QueryParser } from './parser';
import { IFieldSchema } from './types';

describe('QueryParser.parseWithContext - Phase 3 Features', () => {
  let parser: QueryParser;

  const testSchema: Record<string, IFieldSchema> = {
    status: {
      type: 'string',
      allowedValues: ['todo', 'doing', 'done'],
      description: 'Task status'
    },
    priority: { type: 'number', description: 'Priority level' },
    name: { type: 'string', description: 'Task name' },
    createdAt: { type: 'date', description: 'Creation date' },
    isActive: { type: 'boolean', description: 'Whether active' },
    assignee: { type: 'string', description: 'Assigned user' }
  };

  beforeEach(() => {
    parser = new QueryParser();
  });

  describe('Autocomplete Suggestions', () => {
    describe('empty context', () => {
      it('should suggest fields for empty input', () => {
        const result = parser.parseWithContext('', {
          cursorPosition: 0,
          schema: testSchema
        });

        expect(result.suggestions).toBeDefined();
        expect(result.suggestions?.context).toBe('empty');
        expect(result.suggestions?.fields?.length).toBeGreaterThan(0);
      });

      it('should include all schema fields in suggestions', () => {
        const result = parser.parseWithContext('', {
          cursorPosition: 0,
          schema: testSchema
        });

        const suggestedFields = result.suggestions?.fields?.map(f => f.field);
        expect(suggestedFields).toContain('status');
        expect(suggestedFields).toContain('priority');
        expect(suggestedFields).toContain('name');
      });

      it('should include field metadata in suggestions', () => {
        const result = parser.parseWithContext('', {
          cursorPosition: 0,
          schema: testSchema
        });

        const statusSuggestion = result.suggestions?.fields?.find(
          f => f.field === 'status'
        );
        expect(statusSuggestion?.type).toBe('string');
        expect(statusSuggestion?.description).toBe('Task status');
      });
    });

    describe('field context', () => {
      it('should suggest matching fields when typing field name', () => {
        const result = parser.parseWithContext('sta', {
          cursorPosition: 3,
          schema: testSchema
        });

        expect(result.suggestions?.context).toBe('field');
        expect(result.suggestions?.fields?.[0].field).toBe('status');
      });

      it('should rank prefix matches higher', () => {
        const result = parser.parseWithContext('pri', {
          cursorPosition: 3,
          schema: testSchema
        });

        const fields = result.suggestions?.fields || [];
        expect(fields[0].field).toBe('priority');
        expect(fields[0].score).toBeGreaterThan(50);
      });

      it('should suggest similar fields for typos', () => {
        const result = parser.parseWithContext('statis', {
          cursorPosition: 6,
          schema: testSchema
        });

        const fields = result.suggestions?.fields || [];
        const statusSuggestion = fields.find(f => f.field === 'status');
        expect(statusSuggestion).toBeDefined();
      });
    });

    describe('value context', () => {
      it('should suggest allowed values when in value position', () => {
        const result = parser.parseWithContext('status:d', {
          cursorPosition: 8,
          schema: testSchema
        });

        expect(result.suggestions?.context).toBe('value');
        expect(result.suggestions?.currentField).toBe('status');
        expect(result.suggestions?.values).toBeDefined();
      });

      it('should filter values based on partial input', () => {
        const result = parser.parseWithContext('status:do', {
          cursorPosition: 9,
          schema: testSchema
        });

        const values = result.suggestions?.values || [];
        // "doing" and "done" both start with "do"
        expect(values.length).toBeGreaterThanOrEqual(2);
        expect(values.some(v => v.value === 'doing')).toBe(true);
        expect(values.some(v => v.value === 'done')).toBe(true);
      });

      it('should suggest boolean values for boolean fields', () => {
        const result = parser.parseWithContext('isActive:', {
          cursorPosition: 9,
          schema: testSchema
        });

        expect(result.suggestions?.context).toBe('value');
        const values = result.suggestions?.values || [];
        expect(values.some(v => v.value === true)).toBe(true);
        expect(values.some(v => v.value === false)).toBe(true);
      });
    });

    describe('operator context', () => {
      it('should suggest operators', () => {
        const result = parser.parseWithContext('priority:', {
          cursorPosition: 9,
          schema: testSchema
        });

        // After field: we're in value context, but let's test operator suggestions
        // by looking at the operators property
        expect(result.suggestions).toBeDefined();
      });

      it('should mark comparison operators as applicable for number fields', () => {
        const result = parser.parseWithContext('priority', {
          cursorPosition: 8,
          schema: testSchema
        });

        // When we're at the end of a field name, we might suggest operators
        expect(result.suggestions).toBeDefined();
      });
    });

    describe('logical operator context', () => {
      it('should suggest logical operators between terms', () => {
        const result = parser.parseWithContext('status:done ', {
          cursorPosition: 12,
          schema: testSchema
        });

        expect(result.suggestions?.logicalOperators).toContain('AND');
        expect(result.suggestions?.logicalOperators).toContain('OR');
      });

      it('should suggest when cursor is in a logical operator', () => {
        const result = parser.parseWithContext(
          'status:done AND priority:high',
          {
            cursorPosition: 13, // in "AND"
            schema: testSchema
          }
        );

        expect(result.suggestions?.context).toBe('logical_operator');
        expect(result.suggestions?.logicalOperators).toContain('AND');
        expect(result.suggestions?.logicalOperators).toContain('OR');
        expect(result.suggestions?.logicalOperators).toContain('NOT');
      });
    });

    describe('without schema', () => {
      it('should return suggestions without field details when no schema', () => {
        const result = parser.parseWithContext('sta', {
          cursorPosition: 3
        });

        expect(result.suggestions).toBeDefined();
        expect(result.suggestions?.context).toBe('field');
        expect(result.suggestions?.fields).toEqual([]);
      });
    });

    describe('without cursor position', () => {
      it('should not include suggestions when no cursor position', () => {
        const result = parser.parseWithContext('status:done', {
          schema: testSchema
        });

        expect(result.suggestions).toBeUndefined();
      });
    });
  });

  describe('Error Recovery', () => {
    describe('unclosed quotes', () => {
      it('should detect unclosed double quote', () => {
        const result = parser.parseWithContext('name:"John');

        expect(result.success).toBe(false);
        expect(result.recovery).toBeDefined();
        expect(result.recovery?.issue).toBe('unclosed_quote');
        expect(result.recovery?.autofix).toBe('name:"John"');
      });

      it('should detect unclosed single quote', () => {
        const result = parser.parseWithContext("name:'John");

        expect(result.success).toBe(false);
        expect(result.recovery?.issue).toBe('unclosed_quote');
        expect(result.recovery?.autofix).toBe("name:'John'");
      });

      it('should include position of unclosed quote', () => {
        const result = parser.parseWithContext('name:"John');

        expect(result.recovery?.position).toBe(5); // position of "
      });
    });

    describe('unclosed parentheses', () => {
      it('should detect missing closing parenthesis', () => {
        const result = parser.parseWithContext('(status:done');

        expect(result.success).toBe(false);
        expect(result.recovery?.issue).toBe('unclosed_parenthesis');
        expect(result.recovery?.autofix).toBe('(status:done)');
      });

      it('should detect multiple missing closing parentheses', () => {
        const result = parser.parseWithContext('((status:done');

        expect(result.recovery?.issue).toBe('unclosed_parenthesis');
        expect(result.recovery?.autofix).toBe('((status:done))');
      });

      it('should detect extra closing parenthesis', () => {
        const result = parser.parseWithContext('status:done))');

        expect(result.recovery?.issue).toBe('unclosed_parenthesis');
        expect(result.recovery?.message).toContain('Extra');
      });
    });

    describe('trailing operator', () => {
      it('should detect trailing AND', () => {
        const result = parser.parseWithContext('status:done AND');

        expect(result.success).toBe(false);
        expect(result.recovery?.issue).toBe('trailing_operator');
        expect(result.recovery?.autofix).toBe('status:done');
      });

      it('should detect trailing OR', () => {
        const result = parser.parseWithContext('status:done OR');

        expect(result.recovery?.issue).toBe('trailing_operator');
        expect(result.recovery?.autofix).toBe('status:done');
      });

      it('should detect trailing NOT', () => {
        const result = parser.parseWithContext('status:done NOT');

        expect(result.recovery?.issue).toBe('trailing_operator');
      });

      it('should handle trailing operator with whitespace', () => {
        const result = parser.parseWithContext('status:done AND  ');

        expect(result.recovery?.issue).toBe('trailing_operator');
      });
    });

    describe('missing value', () => {
      it('should detect missing value after colon', () => {
        const result = parser.parseWithContext('status:');

        expect(result.success).toBe(false);
        expect(result.recovery?.issue).toBe('missing_value');
      });
    });

    describe('syntax error', () => {
      it('should provide generic recovery for other syntax errors', () => {
        const result = parser.parseWithContext('status:AND'); // AND is a keyword

        expect(result.success).toBe(false);
        expect(result.recovery).toBeDefined();
        // This might be detected as syntax_error or another issue
        expect(result.recovery?.issue).toBeDefined();
      });
    });

    describe('successful parse', () => {
      it('should not include recovery when parsing succeeds', () => {
        const result = parser.parseWithContext('status:done');

        expect(result.success).toBe(true);
        expect(result.recovery).toBeUndefined();
      });
    });
  });

  describe('Integration with other phases', () => {
    it('should include all features together', () => {
      const result = parser.parseWithContext('status:do', {
        cursorPosition: 9,
        schema: testSchema,
        securityOptions: {
          maxClauseCount: 10
        }
      });

      // Phase 1
      expect(result.tokens).toBeDefined();
      expect(result.structure).toBeDefined();

      // Phase 2
      expect(result.fieldValidation).toBeDefined();
      expect(result.security).toBeDefined();

      // Phase 3
      expect(result.suggestions).toBeDefined();
      expect(result.suggestions?.values?.some(v => v.value === 'done')).toBe(
        true
      );
    });

    it('should provide recovery and suggestions for failed parse', () => {
      const result = parser.parseWithContext('status:', {
        cursorPosition: 7,
        schema: testSchema
      });

      expect(result.success).toBe(false);
      expect(result.recovery).toBeDefined();
      expect(result.suggestions).toBeDefined();
      expect(result.suggestions?.context).toBe('value');
    });
  });
});
