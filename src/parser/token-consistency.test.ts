/**
 * Tests to verify that parseWithContext returns the same token information
 * as the standalone input parser (parseQueryTokens).
 *
 * This ensures the integration is correct and both approaches produce
 * consistent results.
 */

import { QueryParser } from './parser';
import { parseQueryTokens, parseQueryInput } from './input-parser';

describe('Token Consistency: parseWithContext vs input parser', () => {
  const parser = new QueryParser();

  describe('token count consistency', () => {
    const testCases = [
      'status:done',
      'status:done AND priority:high',
      'a:1 OR b:2 OR c:3',
      'status:done AND priority:high OR assigned:me',
      '(a:1 AND b:2)',
      'status:',
      'status:d',
      '',
      '   ',
      'hello world',
      '-status:active',
      'name:"John Doe"'
    ];

    testCases.forEach(input => {
      it(`should have same token count for: "${input}"`, () => {
        const contextResult = parser.parseWithContext(input);
        const inputParserResult = parseQueryTokens(input);

        expect(contextResult.tokens.length).toBe(
          inputParserResult.tokens.length
        );
      });
    });
  });

  describe('token content consistency', () => {
    it('should have identical term tokens', () => {
      const input = 'status:done AND priority:high';

      const contextResult = parser.parseWithContext(input);
      const inputParserResult = parseQueryTokens(input);

      // Compare each token
      for (let i = 0; i < contextResult.tokens.length; i++) {
        const ctxToken = contextResult.tokens[i];
        const ipToken = inputParserResult.tokens[i];

        expect(ctxToken.type).toBe(ipToken.type);
        expect(ctxToken.startPosition).toBe(ipToken.startPosition);
        expect(ctxToken.endPosition).toBe(ipToken.endPosition);
        expect(ctxToken.raw).toBe(ipToken.raw);

        if (ctxToken.type === 'term' && ipToken.type === 'term') {
          expect(ctxToken.key).toBe(ipToken.key);
          expect(ctxToken.operator).toBe(ipToken.operator);
          expect(ctxToken.value).toBe(ipToken.value);
        }

        if (ctxToken.type === 'operator' && ipToken.type === 'operator') {
          expect(ctxToken.operator).toBe(ipToken.operator);
        }
      }
    });

    it('should have identical operator tokens', () => {
      const input = 'a:1 AND b:2 OR c:3 NOT d:4';

      const contextResult = parser.parseWithContext(input);
      const inputParserResult = parseQueryTokens(input);

      const ctxOperators = contextResult.tokens.filter(
        t => t.type === 'operator'
      );
      const ipOperators = inputParserResult.tokens.filter(
        t => t.type === 'operator'
      );

      expect(ctxOperators.length).toBe(ipOperators.length);

      for (let i = 0; i < ctxOperators.length; i++) {
        expect(ctxOperators[i]).toEqual(ipOperators[i]);
      }
    });
  });

  describe('position consistency', () => {
    const testCases = [
      'status:done',
      'a:1 AND b:2',
      'name:"hello world"',
      '(status:active OR status:pending)',
      'priority:>5 AND count:<=10'
    ];

    testCases.forEach(input => {
      it(`should have identical positions for: "${input}"`, () => {
        const contextResult = parser.parseWithContext(input);
        const inputParserResult = parseQueryTokens(input);

        for (let i = 0; i < contextResult.tokens.length; i++) {
          const ctxToken = contextResult.tokens[i];
          const ipToken = inputParserResult.tokens[i];

          expect(ctxToken.startPosition).toBe(ipToken.startPosition);
          expect(ctxToken.endPosition).toBe(ipToken.endPosition);

          // Verify raw text matches the slice
          expect(ctxToken.raw).toBe(
            input.substring(ctxToken.startPosition, ctxToken.endPosition)
          );
        }
      });
    });
  });

  describe('cursor/active token consistency', () => {
    it('should identify same active token at cursor position', () => {
      const input = 'status:done AND priority:high';
      const cursorPosition = 5; // in "status"

      const contextResult = parser.parseWithContext(input, { cursorPosition });
      const inputParserResult = parseQueryTokens(input, cursorPosition);

      // Both should identify the same active token
      expect(contextResult.activeTokenIndex).toBe(
        inputParserResult.activeTokenIndex
      );

      if (contextResult.activeToken && inputParserResult.activeToken) {
        expect(contextResult.activeToken.type).toBe(
          inputParserResult.activeToken.type
        );
        expect(contextResult.activeToken.startPosition).toBe(
          inputParserResult.activeToken.startPosition
        );
        expect(contextResult.activeToken.endPosition).toBe(
          inputParserResult.activeToken.endPosition
        );
      }
    });

    it('should identify active token in operator', () => {
      const input = 'status:done AND priority:high';
      const cursorPosition = 13; // in "AND"

      const contextResult = parser.parseWithContext(input, { cursorPosition });
      const inputParserResult = parseQueryTokens(input, cursorPosition);

      expect(contextResult.activeToken?.type).toBe('operator');
      expect(inputParserResult.activeToken?.type).toBe('operator');
      expect(contextResult.activeTokenIndex).toBe(
        inputParserResult.activeTokenIndex
      );
    });

    it('should return same activeTokenIndex for various positions', () => {
      const input = 'a:1 AND b:2 OR c:3';
      const positions = [0, 1, 2, 4, 5, 8, 9, 12, 15, 18];

      for (const pos of positions) {
        const contextResult = parser.parseWithContext(input, {
          cursorPosition: pos
        });
        const inputParserResult = parseQueryTokens(input, pos);

        expect(contextResult.activeTokenIndex).toBe(
          inputParserResult.activeTokenIndex
        );
      }
    });
  });

  describe('parseQueryInput term consistency', () => {
    it('should have consistent term information with parseQueryInput', () => {
      const input = 'status:done AND priority:high';

      const contextResult = parser.parseWithContext(input);
      const inputResult = parseQueryInput(input);

      // Get term tokens from parseWithContext
      const ctxTerms = contextResult.tokens.filter(t => t.type === 'term');

      // Compare with parseQueryInput terms
      expect(ctxTerms.length).toBe(inputResult.terms.length);

      for (let i = 0; i < ctxTerms.length; i++) {
        const ctxTerm = ctxTerms[i];
        const ipTerm = inputResult.terms[i];

        if (ctxTerm.type === 'term') {
          expect(ctxTerm.key).toBe(ipTerm.key);
          expect(ctxTerm.value).toBe(ipTerm.value);
          expect(ctxTerm.operator).toBe(ipTerm.operator);
          expect(ctxTerm.startPosition).toBe(ipTerm.startPosition);
          expect(ctxTerm.endPosition).toBe(ipTerm.endPosition);
          expect(ctxTerm.raw).toBe(ipTerm.raw);
        }
      }
    });

    it('should have consistent logical operator information', () => {
      const input = 'a:1 AND b:2 OR c:3';

      const contextResult = parser.parseWithContext(input);
      const inputResult = parseQueryInput(input);

      // Get operator tokens from parseWithContext
      const ctxOps = contextResult.tokens.filter(t => t.type === 'operator');

      // Compare with parseQueryInput logical operators
      expect(ctxOps.length).toBe(inputResult.logicalOperators.length);

      for (let i = 0; i < ctxOps.length; i++) {
        const ctxOp = ctxOps[i];
        const ipOp = inputResult.logicalOperators[i];

        if (ctxOp.type === 'operator') {
          expect(ctxOp.operator).toBe(ipOp.operator);
          expect(ctxOp.startPosition).toBe(ipOp.position);
        }
      }
    });
  });

  describe('edge case consistency', () => {
    it('should handle empty input consistently', () => {
      const input = '';

      const contextResult = parser.parseWithContext(input);
      const inputParserResult = parseQueryTokens(input);

      expect(contextResult.tokens).toEqual(inputParserResult.tokens);
      expect(contextResult.tokens.length).toBe(0);
    });

    it('should handle incomplete input consistently', () => {
      const input = 'status:';

      const contextResult = parser.parseWithContext(input);
      const inputParserResult = parseQueryTokens(input);

      expect(contextResult.tokens.length).toBe(inputParserResult.tokens.length);
      expect(contextResult.tokens[0]).toEqual(inputParserResult.tokens[0]);
    });

    it('should handle invalid input consistently', () => {
      const input = 'status:done AND';

      const contextResult = parser.parseWithContext(input);
      const inputParserResult = parseQueryTokens(input);

      expect(contextResult.tokens.length).toBe(inputParserResult.tokens.length);

      // Both should have the same tokens even though parsing failed
      for (let i = 0; i < contextResult.tokens.length; i++) {
        expect(contextResult.tokens[i]).toEqual(inputParserResult.tokens[i]);
      }
    });

    it('should handle quoted values consistently', () => {
      const input = 'name:"John Doe" AND status:active';

      const contextResult = parser.parseWithContext(input);
      const inputParserResult = parseQueryTokens(input);

      expect(contextResult.tokens.length).toBe(inputParserResult.tokens.length);

      for (let i = 0; i < contextResult.tokens.length; i++) {
        expect(contextResult.tokens[i]).toEqual(inputParserResult.tokens[i]);
      }
    });

    it('should handle comparison operators consistently', () => {
      const input = 'priority:>5 AND count:<=10';

      const contextResult = parser.parseWithContext(input);
      const inputParserResult = parseQueryTokens(input);

      expect(contextResult.tokens.length).toBe(inputParserResult.tokens.length);

      for (let i = 0; i < contextResult.tokens.length; i++) {
        expect(contextResult.tokens[i]).toEqual(inputParserResult.tokens[i]);
      }
    });

    it('should handle negation consistently', () => {
      const input = '-status:inactive';

      const contextResult = parser.parseWithContext(input);
      const inputParserResult = parseQueryTokens(input);

      expect(contextResult.tokens.length).toBe(inputParserResult.tokens.length);
      expect(contextResult.tokens[0]).toEqual(inputParserResult.tokens[0]);
    });
  });

  describe('structure vs parseQueryInput consistency', () => {
    it('should have consistent isComplete', () => {
      const testCases = [
        { input: 'status:done', expectedComplete: true },
        { input: 'status:', expectedComplete: false },
        { input: 'status:done AND', expectedComplete: false },
        { input: '(status:done', expectedComplete: false },
        { input: 'name:"John', expectedComplete: false }
      ];

      for (const { input, expectedComplete } of testCases) {
        const contextResult = parser.parseWithContext(input);

        expect(contextResult.structure.isComplete).toBe(expectedComplete);
      }
    });

    it('should have consistent referenced fields', () => {
      const input = 'status:done AND priority:high OR status:pending';

      const contextResult = parser.parseWithContext(input);
      const inputResult = parseQueryInput(input);

      // Get unique fields from input parser
      const ipFields = [
        ...new Set(
          inputResult.terms
            .filter(t => t.key !== null)
            .map(t => t.key as string)
        )
      ];

      expect(contextResult.structure.referencedFields.sort()).toEqual(
        ipFields.sort()
      );
    });
  });
});
