import {
  parseQueryInput,
  getTermAtPosition,
  isInputComplete,
  extractKeyValue,
  parseQueryTokens
} from './input-parser';

describe('Input Parser', () => {
  describe('parseQueryInput', () => {
    describe('basic key:value parsing', () => {
      it('should parse a simple key:value input', () => {
        const result = parseQueryInput('status:done');

        expect(result.terms).toHaveLength(1);
        expect(result.terms[0]).toMatchObject({
          key: 'status',
          operator: ':',
          value: 'done'
        });
        expect(result.activeTerm).toEqual(result.terms[0]);
        expect(result.cursorContext).toBe('value');
      });

      it('should parse an incomplete key:value input (user typing value)', () => {
        const result = parseQueryInput('status:d');

        expect(result.terms).toHaveLength(1);
        expect(result.terms[0]).toMatchObject({
          key: 'status',
          operator: ':',
          value: 'd'
        });
      });

      it('should parse a key with no value yet', () => {
        const result = parseQueryInput('status:');

        expect(result.terms).toHaveLength(1);
        expect(result.terms[0]).toMatchObject({
          key: 'status',
          operator: ':',
          value: null
        });
        expect(result.cursorContext).toBe('value');
      });

      it('should handle bare values (no key)', () => {
        const result = parseQueryInput('hello');

        expect(result.terms).toHaveLength(1);
        expect(result.terms[0]).toMatchObject({
          key: null,
          operator: null,
          value: 'hello'
        });
      });

      it('should handle empty input', () => {
        const result = parseQueryInput('');

        expect(result.terms).toHaveLength(0);
        expect(result.activeTerm).toBeNull();
        expect(result.cursorContext).toBe('empty');
      });

      it('should handle whitespace-only input', () => {
        const result = parseQueryInput('   ');

        expect(result.terms).toHaveLength(0);
        expect(result.cursorContext).toBe('empty');
      });
    });

    describe('comparison operators', () => {
      it('should parse greater than operator', () => {
        const result = parseQueryInput('priority:>5');

        expect(result.terms[0]).toMatchObject({
          key: 'priority',
          operator: ':>',
          value: '5'
        });
      });

      it('should parse greater than or equal operator', () => {
        const result = parseQueryInput('priority:>=5');

        expect(result.terms[0]).toMatchObject({
          key: 'priority',
          operator: ':>=',
          value: '5'
        });
      });

      it('should parse less than operator', () => {
        const result = parseQueryInput('priority:<5');

        expect(result.terms[0]).toMatchObject({
          key: 'priority',
          operator: ':<',
          value: '5'
        });
      });

      it('should parse less than or equal operator', () => {
        const result = parseQueryInput('priority:<=5');

        expect(result.terms[0]).toMatchObject({
          key: 'priority',
          operator: ':<=',
          value: '5'
        });
      });

      it('should parse not equal operator', () => {
        const result = parseQueryInput('status:!=active');

        expect(result.terms[0]).toMatchObject({
          key: 'status',
          operator: ':!=',
          value: 'active'
        });
      });

      it('should parse equal operator with colon-equals', () => {
        const result = parseQueryInput('count:=10');

        expect(result.terms[0]).toMatchObject({
          key: 'count',
          operator: ':=',
          value: '10'
        });
      });
    });

    describe('multiple terms', () => {
      it('should parse multiple space-separated terms', () => {
        const result = parseQueryInput('status:done priority:high');

        expect(result.terms).toHaveLength(2);
        expect(result.terms[0]).toMatchObject({
          key: 'status',
          operator: ':',
          value: 'done'
        });
        expect(result.terms[1]).toMatchObject({
          key: 'priority',
          operator: ':',
          value: 'high'
        });
      });

      it('should parse terms with logical operators', () => {
        const result = parseQueryInput('status:done AND priority:high');

        expect(result.terms).toHaveLength(2);
        expect(result.logicalOperators).toHaveLength(1);
        expect(result.logicalOperators[0]).toMatchObject({
          operator: 'AND'
        });
      });

      it('should parse terms with OR operator', () => {
        const result = parseQueryInput('status:todo OR status:doing');

        expect(result.terms).toHaveLength(2);
        expect(result.logicalOperators).toHaveLength(1);
        expect(result.logicalOperators[0].operator).toBe('OR');
      });

      it('should parse terms with NOT operator', () => {
        const result = parseQueryInput('status:done NOT priority:low');

        expect(result.terms).toHaveLength(2);
        expect(result.logicalOperators).toHaveLength(1);
        expect(result.logicalOperators[0].operator).toBe('NOT');
      });

      it('should handle mixed bare values and key:value terms', () => {
        const result = parseQueryInput('hello status:active world');

        expect(result.terms).toHaveLength(3);
        expect(result.terms[0]).toMatchObject({ key: null, value: 'hello' });
        expect(result.terms[1]).toMatchObject({
          key: 'status',
          value: 'active'
        });
        expect(result.terms[2]).toMatchObject({ key: null, value: 'world' });
      });
    });

    describe('quoted values', () => {
      it('should parse double-quoted values', () => {
        const result = parseQueryInput('name:"John Doe"');

        expect(result.terms[0]).toMatchObject({
          key: 'name',
          operator: ':',
          value: '"John Doe"'
        });
      });

      it('should parse single-quoted values', () => {
        const result = parseQueryInput("name:'Jane Doe'");

        expect(result.terms[0]).toMatchObject({
          key: 'name',
          operator: ':',
          value: "'Jane Doe'"
        });
      });

      it('should parse bare quoted values', () => {
        const result = parseQueryInput('"hello world"');

        expect(result.terms[0]).toMatchObject({
          key: null,
          operator: null,
          value: '"hello world"'
        });
      });
    });

    describe('negation', () => {
      it('should handle negation prefix on key:value', () => {
        const result = parseQueryInput('-status:active');

        expect(result.terms[0]).toMatchObject({
          key: '-status',
          operator: ':',
          value: 'active'
        });
      });

      it('should handle negation prefix on bare value', () => {
        const result = parseQueryInput('-important');

        expect(result.terms[0]).toMatchObject({
          key: null,
          value: '-important'
        });
      });
    });

    describe('cursor position tracking', () => {
      it('should identify active term based on cursor position', () => {
        const input = 'status:done priority:high';
        const result = parseQueryInput(input, 5); // cursor in "status"

        expect(result.activeTerm?.key).toBe('status');
        expect(result.cursorContext).toBe('key');
      });

      it('should identify cursor in value position', () => {
        const input = 'status:done';
        const result = parseQueryInput(input, 9); // cursor in "done"

        expect(result.activeTerm?.key).toBe('status');
        expect(result.cursorContext).toBe('value');
      });

      it('should identify cursor at end of input', () => {
        const input = 'status:done';
        const result = parseQueryInput(input, 11);

        expect(result.activeTerm?.key).toBe('status');
        expect(result.cursorContext).toBe('value');
      });

      it('should identify cursor between terms', () => {
        const input = 'status:done   priority:high';
        const result = parseQueryInput(input, 13); // cursor in whitespace

        expect(result.cursorContext).toBe('between');
      });

      it('should handle cursor at operator position', () => {
        const input = 'status:done';
        const result = parseQueryInput(input, 6); // cursor at ":"

        expect(result.activeTerm?.key).toBe('status');
        expect(result.cursorContext).toBe('operator');
      });
    });

    describe('position tracking', () => {
      it('should track start and end positions of terms', () => {
        const result = parseQueryInput('status:done');

        expect(result.terms[0].startPosition).toBe(0);
        expect(result.terms[0].endPosition).toBe(11);
        expect(result.terms[0].raw).toBe('status:done');
      });

      it('should track positions for multiple terms', () => {
        const result = parseQueryInput('a:1 b:2');

        expect(result.terms[0].startPosition).toBe(0);
        expect(result.terms[0].endPosition).toBe(3);
        expect(result.terms[1].startPosition).toBe(4);
        expect(result.terms[1].endPosition).toBe(7);
      });
    });

    describe('options', () => {
      it('should apply case-insensitive keys when option is set', () => {
        const result = parseQueryInput('STATUS:done', undefined, {
          caseInsensitiveKeys: true
        });

        expect(result.terms[0].key).toBe('status');
      });

      it('should preserve key case by default', () => {
        const result = parseQueryInput('STATUS:done');

        expect(result.terms[0].key).toBe('STATUS');
      });
    });

    describe('parentheses handling', () => {
      it('should handle parentheses in input', () => {
        const result = parseQueryInput('(status:done OR status:todo)');

        expect(result.terms).toHaveLength(2);
        expect(result.terms[0].key).toBe('status');
        expect(result.terms[1].key).toBe('status');
      });

      it('should handle nested parentheses', () => {
        const result = parseQueryInput('((a:1 OR b:2) AND c:3)');

        expect(result.terms).toHaveLength(3);
      });
    });
  });

  describe('getTermAtPosition', () => {
    it('should return the term at a given position', () => {
      const term = getTermAtPosition('status:done priority:high', 5);

      expect(term?.key).toBe('status');
    });

    it('should return null when position is between terms', () => {
      const term = getTermAtPosition('a:1   b:2', 4);

      expect(term).toBeNull();
    });

    it('should return the correct term when cursor is at the end', () => {
      const term = getTermAtPosition('status:done', 11);

      expect(term?.key).toBe('status');
      expect(term?.value).toBe('done');
    });
  });

  describe('isInputComplete', () => {
    it('should return true for complete key:value expression', () => {
      expect(isInputComplete('status:done')).toBe(true);
    });

    it('should return true for multiple complete terms', () => {
      expect(isInputComplete('status:done AND priority:high')).toBe(true);
    });

    it('should return false for incomplete key:value (no value)', () => {
      expect(isInputComplete('status:')).toBe(false);
    });

    it('should return false for empty input', () => {
      expect(isInputComplete('')).toBe(false);
    });

    it('should return false for input ending with logical operator', () => {
      expect(isInputComplete('status:done AND')).toBe(false);
      expect(isInputComplete('status:done OR')).toBe(false);
      expect(isInputComplete('status:done NOT')).toBe(false);
    });

    it('should return false for unclosed quotes', () => {
      expect(isInputComplete('name:"John')).toBe(false);
      expect(isInputComplete("name:'Jane")).toBe(false);
    });

    it('should return false for unclosed parentheses', () => {
      expect(isInputComplete('(status:done')).toBe(false);
      expect(isInputComplete('status:done)')).toBe(false);
    });

    it('should return true for complete bare value', () => {
      expect(isInputComplete('hello')).toBe(true);
    });

    it('should return true for complete quoted value', () => {
      expect(isInputComplete('"hello world"')).toBe(true);
    });
  });

  describe('extractKeyValue', () => {
    it('should extract key and value from simple input', () => {
      const result = extractKeyValue('status:done');

      expect(result).toEqual({ key: 'status', value: 'done' });
    });

    it('should extract key with null value for incomplete input', () => {
      const result = extractKeyValue('status:');

      expect(result).toEqual({ key: 'status', value: null });
    });

    it('should return null for bare value (no key)', () => {
      const result = extractKeyValue('hello');

      expect(result).toBeNull();
    });

    it('should return null for empty input', () => {
      const result = extractKeyValue('');

      expect(result).toBeNull();
    });

    it('should handle leading/trailing whitespace', () => {
      const result = extractKeyValue('  status:done  ');

      expect(result).toEqual({ key: 'status', value: 'done' });
    });

    it('should return the first key:value when multiple are present', () => {
      const result = extractKeyValue('status:done priority:high');

      expect(result).toEqual({ key: 'status', value: 'done' });
    });

    it('should handle comparison operators', () => {
      const result = extractKeyValue('priority:>5');

      expect(result).toEqual({ key: 'priority', value: '5' });
    });
  });

  describe('parseQueryTokens - interleaved sequence', () => {
    it('should return empty array for empty input', () => {
      const result = parseQueryTokens('');

      expect(result.tokens).toHaveLength(0);
      expect(result.activeToken).toBeNull();
      expect(result.activeTokenIndex).toBe(-1);
    });

    it('should parse a single term', () => {
      const result = parseQueryTokens('status:done');

      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0]).toMatchObject({
        type: 'term',
        key: 'status',
        value: 'done'
      });
    });

    it('should parse compound expression with AND', () => {
      const result = parseQueryTokens('keyVal1:val1 AND keyVal2:val2');

      expect(result.tokens).toHaveLength(3);

      // First term
      expect(result.tokens[0]).toMatchObject({
        type: 'term',
        key: 'keyVal1',
        value: 'val1'
      });

      // AND operator
      expect(result.tokens[1]).toMatchObject({
        type: 'operator',
        operator: 'AND'
      });

      // Second term
      expect(result.tokens[2]).toMatchObject({
        type: 'term',
        key: 'keyVal2',
        value: 'val2'
      });
    });

    it('should parse compound expression with OR', () => {
      const result = parseQueryTokens(
        'status:todo OR status:doing OR status:done'
      );

      expect(result.tokens).toHaveLength(5);
      expect(result.tokens[0].type).toBe('term');
      expect(result.tokens[1]).toMatchObject({
        type: 'operator',
        operator: 'OR'
      });
      expect(result.tokens[2].type).toBe('term');
      expect(result.tokens[3]).toMatchObject({
        type: 'operator',
        operator: 'OR'
      });
      expect(result.tokens[4].type).toBe('term');
    });

    it('should parse expression with NOT', () => {
      const result = parseQueryTokens('status:active NOT priority:low');

      expect(result.tokens).toHaveLength(3);
      expect(result.tokens[0]).toMatchObject({
        type: 'term',
        key: 'status',
        value: 'active'
      });
      expect(result.tokens[1]).toMatchObject({
        type: 'operator',
        operator: 'NOT'
      });
      expect(result.tokens[2]).toMatchObject({
        type: 'term',
        key: 'priority',
        value: 'low'
      });
    });

    it('should include position information for all tokens', () => {
      const input = 'a:1 AND b:2';
      const result = parseQueryTokens(input);

      expect(result.tokens).toHaveLength(3);

      // First term: 'a:1' at positions 0-3
      expect(result.tokens[0]).toMatchObject({
        type: 'term',
        startPosition: 0,
        endPosition: 3,
        raw: 'a:1'
      });

      // AND operator at positions 4-7
      expect(result.tokens[1]).toMatchObject({
        type: 'operator',
        operator: 'AND',
        startPosition: 4,
        endPosition: 7,
        raw: 'AND'
      });

      // Second term: 'b:2' at positions 8-11
      expect(result.tokens[2]).toMatchObject({
        type: 'term',
        startPosition: 8,
        endPosition: 11,
        raw: 'b:2'
      });
    });

    it('should identify active token based on cursor position', () => {
      const input = 'status:done AND priority:high';

      // Cursor in first term
      let result = parseQueryTokens(input, 5);
      expect(result.activeToken?.type).toBe('term');
      expect(result.activeTokenIndex).toBe(0);

      // Cursor in AND operator
      result = parseQueryTokens(input, 13);
      expect(result.activeToken?.type).toBe('operator');
      expect(result.activeTokenIndex).toBe(1);

      // Cursor in second term
      result = parseQueryTokens(input, 20);
      expect(result.activeToken?.type).toBe('term');
      expect(result.activeTokenIndex).toBe(2);
    });

    it('should handle incomplete expressions', () => {
      const result = parseQueryTokens('status:done AND');

      expect(result.tokens).toHaveLength(2);
      expect(result.tokens[0]).toMatchObject({
        type: 'term',
        key: 'status',
        value: 'done'
      });
      expect(result.tokens[1]).toMatchObject({
        type: 'operator',
        operator: 'AND'
      });
    });

    it('should handle partial value in term', () => {
      const result = parseQueryTokens('status:d');

      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0]).toMatchObject({
        type: 'term',
        key: 'status',
        value: 'd'
      });
    });

    it('should handle term with no value yet', () => {
      const result = parseQueryTokens('status:');

      expect(result.tokens).toHaveLength(1);
      expect(result.tokens[0]).toMatchObject({
        type: 'term',
        key: 'status',
        value: null
      });
    });

    it('should handle mixed operators', () => {
      const result = parseQueryTokens('a:1 AND b:2 OR c:3');

      expect(result.tokens).toHaveLength(5);
      expect(result.tokens[0].type).toBe('term');
      expect(result.tokens[1]).toMatchObject({
        type: 'operator',
        operator: 'AND'
      });
      expect(result.tokens[2].type).toBe('term');
      expect(result.tokens[3]).toMatchObject({
        type: 'operator',
        operator: 'OR'
      });
      expect(result.tokens[4].type).toBe('term');
    });

    it('should handle bare values mixed with key:value terms', () => {
      const result = parseQueryTokens('hello AND status:active');

      expect(result.tokens).toHaveLength(3);
      expect(result.tokens[0]).toMatchObject({
        type: 'term',
        key: null,
        value: 'hello'
      });
      expect(result.tokens[1]).toMatchObject({
        type: 'operator',
        operator: 'AND'
      });
      expect(result.tokens[2]).toMatchObject({
        type: 'term',
        key: 'status',
        value: 'active'
      });
    });

    it('should handle complex real-world query', () => {
      const result = parseQueryTokens(
        'status:open AND priority:high OR assigned:me'
      );

      expect(result.tokens).toHaveLength(5);

      // Verify order: term, AND, term, OR, term
      expect(result.tokens.map(t => t.type)).toEqual([
        'term',
        'operator',
        'term',
        'operator',
        'term'
      ]);

      const operators = result.tokens
        .filter(
          (t): t is import('./input-parser').IQueryOperatorToken =>
            t.type === 'operator'
        )
        .map(t => t.operator);
      expect(operators).toEqual(['AND', 'OR']);
    });

    it('should find active token at end of input', () => {
      const input = 'status:done';
      const result = parseQueryTokens(input, input.length);

      expect(result.activeToken).not.toBeNull();
      expect(result.activeTokenIndex).toBe(0);
    });
  });

  describe('edge cases and real-world scenarios', () => {
    it('should handle the example from the issue: status:d', () => {
      const result = parseQueryInput('status:d');

      expect(result.terms[0]).toMatchObject({
        key: 'status',
        value: 'd'
      });
      expect(extractKeyValue('status:d')).toEqual({
        key: 'status',
        value: 'd'
      });
    });

    it('should handle autocomplete scenario: user typing status:do', () => {
      const result = parseQueryInput('status:do');

      expect(result.terms[0].key).toBe('status');
      expect(result.terms[0].value).toBe('do');
      expect(result.activeTerm?.value).toBe('do');
    });

    it('should handle multiple fields for highlighting', () => {
      const result = parseQueryInput(
        'status:active priority:high assigned:john'
      );

      expect(result.terms).toHaveLength(3);

      // Verify each term has position info for highlighting
      result.terms.forEach(term => {
        expect(term.startPosition).toBeGreaterThanOrEqual(0);
        expect(term.endPosition).toBeGreaterThan(term.startPosition);
        expect(term.raw.length).toBeGreaterThan(0);
      });
    });

    it('should handle field names with dots (nested properties)', () => {
      const result = parseQueryInput('user.name:john');

      expect(result.terms[0]).toMatchObject({
        key: 'user.name',
        operator: ':',
        value: 'john'
      });
    });

    it('should handle field names with underscores', () => {
      const result = parseQueryInput('created_at:today');

      expect(result.terms[0].key).toBe('created_at');
    });

    it('should handle field names with hyphens', () => {
      const result = parseQueryInput('last-updated:yesterday');

      expect(result.terms[0].key).toBe('last-updated');
    });

    it('should handle numeric values', () => {
      const result = parseQueryInput('count:42');

      expect(result.terms[0].value).toBe('42');
    });

    it('should handle decimal values', () => {
      const result = parseQueryInput('price:19.99');

      expect(result.terms[0].value).toBe('19.99');
    });

    it('should handle complex real-world query', () => {
      const result = parseQueryInput(
        'status:open AND (priority:high OR priority:critical) -assigned:nobody'
      );

      expect(result.terms.length).toBeGreaterThanOrEqual(3);
      expect(result.logicalOperators.length).toBeGreaterThanOrEqual(1);
    });
  });
});
