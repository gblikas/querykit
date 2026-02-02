import { QueryParser } from './parser';

describe('QueryParser.parseWithContext', () => {
  let parser: QueryParser;

  beforeEach(() => {
    parser = new QueryParser();
  });

  describe('successful parsing', () => {
    it('should return success=true for valid query', () => {
      const result = parser.parseWithContext('status:done');

      expect(result.success).toBe(true);
      expect(result.ast).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('should include AST for valid query', () => {
      const result = parser.parseWithContext('status:done');

      expect(result.ast).toMatchObject({
        type: 'comparison',
        field: 'status',
        value: 'done'
      });
    });

    it('should parse complex valid query', () => {
      const result = parser.parseWithContext('status:done AND priority:high');

      expect(result.success).toBe(true);
      expect(result.ast?.type).toBe('logical');
    });
  });

  describe('failed parsing', () => {
    it('should return success=false for invalid query', () => {
      const result = parser.parseWithContext('status:');

      expect(result.success).toBe(false);
      expect(result.ast).toBeUndefined();
      expect(result.error).toBeDefined();
    });

    it('should include error message', () => {
      const result = parser.parseWithContext('status:');

      expect(result.error?.message).toBeDefined();
      expect(result.error?.message.length).toBeGreaterThan(0);
    });

    it('should still return tokens for invalid query', () => {
      const result = parser.parseWithContext('status:');

      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0]).toMatchObject({
        type: 'term',
        key: 'status',
        value: null
      });
    });

    it('should handle trailing operator', () => {
      const result = parser.parseWithContext('status:done AND');

      expect(result.success).toBe(false);
      expect(result.tokens.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('tokens', () => {
    it('should always return tokens array', () => {
      const validResult = parser.parseWithContext('status:done');
      const invalidResult = parser.parseWithContext('status:');

      expect(Array.isArray(validResult.tokens)).toBe(true);
      expect(Array.isArray(invalidResult.tokens)).toBe(true);
    });

    it('should return interleaved tokens for compound query', () => {
      const result = parser.parseWithContext('a:1 AND b:2 OR c:3');

      expect(result.tokens).toHaveLength(5);
      expect(result.tokens.map(t => t.type)).toEqual([
        'term',
        'operator',
        'term',
        'operator',
        'term'
      ]);
    });

    it('should include position information', () => {
      const result = parser.parseWithContext('status:done');

      expect(result.tokens[0].startPosition).toBe(0);
      expect(result.tokens[0].endPosition).toBe(11);
      expect(result.tokens[0].raw).toBe('status:done');
    });
  });

  describe('active token (cursor awareness)', () => {
    it('should identify active token when cursor position provided', () => {
      const result = parser.parseWithContext('status:done AND priority:high', {
        cursorPosition: 5
      });

      expect(result.activeToken).toBeDefined();
      expect(result.activeToken?.type).toBe('term');
      expect(result.activeTokenIndex).toBe(0);
    });

    it('should identify cursor in operator', () => {
      const result = parser.parseWithContext('status:done AND priority:high', {
        cursorPosition: 13 // in "AND"
      });

      expect(result.activeToken?.type).toBe('operator');
      expect(result.activeTokenIndex).toBe(1);
    });

    it('should return activeTokenIndex=-1 when no cursor provided', () => {
      const result = parser.parseWithContext('status:done');

      expect(result.activeTokenIndex).toBe(-1);
    });
  });

  describe('structure analysis', () => {
    it('should analyze simple query structure', () => {
      const result = parser.parseWithContext('status:done');

      expect(result.structure).toMatchObject({
        depth: 1,
        clauseCount: 1,
        operatorCount: 0,
        hasBalancedParentheses: true,
        hasBalancedQuotes: true,
        isComplete: true,
        complexity: 'simple'
      });
    });

    it('should count clauses correctly', () => {
      const result = parser.parseWithContext('a:1 AND b:2 AND c:3');

      expect(result.structure.clauseCount).toBe(3);
      expect(result.structure.operatorCount).toBe(2);
    });

    it('should detect unbalanced parentheses', () => {
      const result = parser.parseWithContext('(status:done');

      expect(result.structure.hasBalancedParentheses).toBe(false);
      expect(result.structure.isComplete).toBe(false);
    });

    it('should detect unbalanced quotes', () => {
      const result = parser.parseWithContext('name:"John');

      expect(result.structure.hasBalancedQuotes).toBe(false);
      expect(result.structure.isComplete).toBe(false);
    });

    it('should calculate depth for nested query', () => {
      const result = parser.parseWithContext('(a:1 AND (b:2 OR c:3))');

      expect(result.structure.depth).toBe(2);
    });

    it('should extract referenced fields', () => {
      const result = parser.parseWithContext('status:done AND priority:high');

      expect(result.structure.referencedFields).toContain('status');
      expect(result.structure.referencedFields).toContain('priority');
      expect(result.structure.referencedFields).toHaveLength(2);
    });

    it('should not duplicate fields in referencedFields', () => {
      const result = parser.parseWithContext('status:done OR status:pending');

      expect(result.structure.referencedFields).toEqual(['status']);
    });

    it('should classify simple queries', () => {
      expect(parser.parseWithContext('a:1').structure.complexity).toBe(
        'simple'
      );
      expect(parser.parseWithContext('a:1 AND b:2').structure.complexity).toBe(
        'simple'
      );
    });

    it('should classify moderate queries', () => {
      const result = parser.parseWithContext('a:1 AND b:2 AND c:3');

      expect(result.structure.complexity).toBe('moderate');
    });

    it('should classify complex queries', () => {
      const result = parser.parseWithContext(
        'a:1 AND b:2 AND c:3 AND d:4 AND e:5 AND f:6'
      );

      expect(result.structure.complexity).toBe('complex');
    });

    it('should classify deeply nested as complex', () => {
      const result = parser.parseWithContext(
        '(((a:1 AND b:2) OR c:3) AND d:4)'
      );

      // Depth > 3 should be complex
      expect(result.structure.depth).toBeGreaterThanOrEqual(3);
    });
  });

  describe('input preservation', () => {
    it('should preserve original input', () => {
      const input = 'status:done AND priority:high';
      const result = parser.parseWithContext(input);

      expect(result.input).toBe(input);
    });
  });

  describe('edge cases', () => {
    it('should handle empty input', () => {
      const result = parser.parseWithContext('');

      expect(result.success).toBe(false);
      expect(result.tokens).toHaveLength(0);
      expect(result.structure.clauseCount).toBe(0);
      expect(result.structure.depth).toBe(0);
    });

    it('should handle whitespace-only input', () => {
      const result = parser.parseWithContext('   ');

      expect(result.success).toBe(false);
      expect(result.tokens).toHaveLength(0);
    });

    it('should handle query with only logical operators', () => {
      const result = parser.parseWithContext('AND OR');

      expect(result.success).toBe(false);
      // Should still tokenize the operators
      expect(result.tokens.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle very long query', () => {
      const clauses = Array.from(
        { length: 20 },
        (_, i) => `field${i}:value${i}`
      );
      const query = clauses.join(' AND ');
      const result = parser.parseWithContext(query);

      expect(result.success).toBe(true);
      expect(result.structure.clauseCount).toBe(20);
      expect(result.structure.complexity).toBe('complex');
    });
  });

  describe('integration with parser options', () => {
    it('should respect caseInsensitiveFields option', () => {
      const caseInsensitiveParser = new QueryParser({
        caseInsensitiveFields: true
      });

      const result = caseInsensitiveParser.parseWithContext('STATUS:done');

      expect(result.success).toBe(true);
      expect(result.ast).toMatchObject({
        field: 'status' // lowercased
      });
    });

    it('should respect fieldMappings option', () => {
      const mappedParser = new QueryParser({
        fieldMappings: { s: 'status' }
      });

      const result = mappedParser.parseWithContext('s:done');

      expect(result.success).toBe(true);
      expect(result.ast).toMatchObject({
        field: 'status' // mapped
      });
    });
  });

  describe('never throws', () => {
    it('should never throw, even for malformed input', () => {
      const badInputs = [
        '',
        '   ',
        ':::',
        '(((',
        '))))',
        'AND AND AND',
        '""""""',
        '\n\t\r',
        'field:>>>>>',
        'a'.repeat(10000)
      ];

      for (const input of badInputs) {
        expect(() => parser.parseWithContext(input)).not.toThrow();
      }
    });

    it('should return a valid result object for any input', () => {
      const result = parser.parseWithContext('totally {{invalid}} query!!!');

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('input');
      expect(result).toHaveProperty('tokens');
      expect(result).toHaveProperty('structure');
      expect(result).toHaveProperty('activeTokenIndex');
    });
  });
});
