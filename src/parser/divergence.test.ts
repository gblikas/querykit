/**
 * Tests documenting the differences between the input parser and main parser.
 *
 * IMPORTANT: The input parser is designed for UI/UX purposes (autocomplete, highlighting)
 * and uses simplified regex-based tokenization. The main parser uses Liqe's full grammar.
 *
 * These tests document known divergences so developers understand the differences.
 */

import { QueryParser } from './parser';
import {
  parseQueryInput,
  extractKeyValue,
  isInputComplete
} from './input-parser';

describe('Parser Divergence Documentation', () => {
  const mainParser = new QueryParser();

  /**
   * Helper to check if main parser accepts input
   */
  function mainParserAccepts(input: string): boolean {
    try {
      mainParser.parse(input);
      return true;
    } catch {
      return false;
    }
  }

  describe('Known Divergences - Logical operators as values', () => {
    /**
     * DIVERGENCE: Liqe treats AND/OR/NOT as reserved keywords.
     * The main parser REJECTS these as values.
     * The input parser correctly handles them as literal values.
     */
    it('DIVERGENCE: "status:AND" - main parser rejects, input parser accepts', () => {
      const input = 'status:AND';

      // Main parser (Liqe) treats AND as a keyword and fails
      expect(mainParserAccepts(input)).toBe(false);

      // Input parser correctly handles it as a value
      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'status',
        operator: ':',
        value: 'AND'
      });

      // extractKeyValue also works
      expect(extractKeyValue(input)).toEqual({ key: 'status', value: 'AND' });
    });

    it('DIVERGENCE: "status:OR" - main parser rejects, input parser accepts', () => {
      const input = 'status:OR';

      // Main parser rejects
      expect(mainParserAccepts(input)).toBe(false);

      // Input parser handles it
      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'status',
        value: 'OR'
      });
    });

    it('DIVERGENCE: "status:NOT" - main parser rejects, input parser accepts', () => {
      const input = 'status:NOT';

      expect(mainParserAccepts(input)).toBe(false);

      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'status',
        value: 'NOT'
      });
    });

    it('WORKAROUND: Quote the value to make main parser accept it', () => {
      const input = 'status:"AND"';

      // Both parsers handle quoted values
      expect(mainParserAccepts(input)).toBe(true);

      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'status',
        value: '"AND"'
      });
    });
  });

  describe('Known Divergences - Incomplete input', () => {
    /**
     * The main advantage of the input parser: handling incomplete input
     * that users are still typing.
     */
    it('DIVERGENCE: "status:" - main parser rejects, input parser returns partial', () => {
      const input = 'status:';

      // Main parser requires a value
      expect(mainParserAccepts(input)).toBe(false);

      // Input parser returns what it can
      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'status',
        operator: ':',
        value: null
      });
      expect(inputResult.cursorContext).toBe('value');
    });

    it('DIVERGENCE: "status:done AND" - main parser rejects trailing operator', () => {
      const input = 'status:done AND';

      // Main parser rejects incomplete expression
      expect(mainParserAccepts(input)).toBe(false);

      // Input parser parses what it can
      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'status',
        value: 'done'
      });
      expect(inputResult.logicalOperators).toContainEqual(
        expect.objectContaining({ operator: 'AND' })
      );

      // isInputComplete correctly identifies this as incomplete
      expect(isInputComplete(input)).toBe(false);
    });

    it('DIVERGENCE: unclosed quote - main parser rejects, input parser handles', () => {
      const input = 'name:"John';

      expect(mainParserAccepts(input)).toBe(false);

      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'name',
        value: '"John' // Partial quoted value
      });

      expect(isInputComplete(input)).toBe(false);
    });
  });

  describe('Known Divergences - Range and Array syntax', () => {
    /**
     * Complex syntax like ranges and arrays are preprocessed by the main parser
     * but not fully understood by the input parser.
     */
    it('DIVERGENCE: "field:[1 TO 10]" - different handling', () => {
      const input = 'field:[1 TO 10]';

      // Main parser handles range syntax
      expect(mainParserAccepts(input)).toBe(true);
      const mainAst = mainParser.parse(input);
      // Main parser converts to logical AND of comparisons
      expect(mainAst.type).toBe('logical');

      // Input parser sees partial bracket content
      const inputResult = parseQueryInput(input);
      // It doesn't fully understand range syntax
      expect(inputResult.terms.length).toBeGreaterThanOrEqual(1);
      expect(inputResult.terms[0].key).toBe('field');
    });

    it('DIVERGENCE: "field:[a, b, c]" - main parser expands, input parser partial', () => {
      const input = 'field:[a, b, c]';

      // Main parser expands to OR expression
      expect(mainParserAccepts(input)).toBe(true);
      const mainAst = mainParser.parse(input);
      expect(mainAst.type).toBe('logical');

      // Input parser handles it partially
      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0].key).toBe('field');
      // The value parsing for array syntax is limited
    });
  });

  describe('Consistent Behavior - Simple cases', () => {
    /**
     * For typical key:value patterns, both parsers agree.
     */
    it('CONSISTENT: "status:done" - both parsers agree', () => {
      const input = 'status:done';

      expect(mainParserAccepts(input)).toBe(true);
      const mainAst = mainParser.parse(input);
      expect(mainAst).toMatchObject({
        type: 'comparison',
        field: 'status',
        value: 'done'
      });

      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'status',
        value: 'done'
      });

      expect(extractKeyValue(input)).toEqual({ key: 'status', value: 'done' });
    });

    it('CONSISTENT: "status:d" - partial value works in both', () => {
      const input = 'status:d';

      // Main parser accepts partial values
      expect(mainParserAccepts(input)).toBe(true);
      const mainAst = mainParser.parse(input);
      expect(mainAst).toMatchObject({
        type: 'comparison',
        field: 'status',
        value: 'd'
      });

      // Input parser matches
      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'status',
        value: 'd'
      });
    });

    it('CONSISTENT: "priority:>5" - comparison operators work in both', () => {
      const input = 'priority:>5';

      expect(mainParserAccepts(input)).toBe(true);
      const mainAst = mainParser.parse(input);
      expect(mainAst).toMatchObject({
        type: 'comparison',
        field: 'priority',
        operator: '>',
        value: 5
      });

      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'priority',
        operator: ':>',
        value: '5' // Note: input parser keeps as string (for display)
      });
    });

    it('CONSISTENT: quoted values work in both (with quote handling difference)', () => {
      const input = 'name:"John Doe"';

      expect(mainParserAccepts(input)).toBe(true);
      const mainAst = mainParser.parse(input);
      expect(mainAst).toMatchObject({
        type: 'comparison',
        field: 'name',
        value: 'John Doe' // Main parser STRIPS quotes
      });

      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0]).toMatchObject({
        key: 'name',
        value: '"John Doe"' // Input parser PRESERVES quotes (for highlighting)
      });
    });

    it('CONSISTENT: multiple terms with AND', () => {
      const input = 'status:done AND priority:high';

      expect(mainParserAccepts(input)).toBe(true);
      const mainAst = mainParser.parse(input);
      expect(mainAst.type).toBe('logical');

      const inputResult = parseQueryInput(input);
      expect(inputResult.terms).toHaveLength(2);
      expect(inputResult.logicalOperators).toHaveLength(1);
    });
  });

  describe('Type Differences', () => {
    /**
     * The main parser converts values to their proper types.
     * The input parser keeps everything as strings (for display purposes).
     */
    it('TYPE DIFFERENCE: numeric values', () => {
      const input = 'count:42';

      const mainAst = mainParser.parse(input);
      expect(mainAst).toMatchObject({
        value: 42 // Number type
      });

      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0].value).toBe('42'); // String type
    });

    it('TYPE DIFFERENCE: boolean values', () => {
      const input = 'active:true';

      const mainAst = mainParser.parse(input);
      expect(mainAst).toMatchObject({
        value: true // Boolean type
      });

      const inputResult = parseQueryInput(input);
      expect(inputResult.terms[0].value).toBe('true'); // String type
    });
  });

  describe('Developer Guidance', () => {
    /**
     * Summary of when to use each parser and known limitations.
     */
    it('documents usage guidance', () => {
      /**
       * USE THE MAIN PARSER (QueryParser) when:
       * - Executing queries against a database
       * - Validating complete query syntax
       * - Need proper type conversion (string -> number/boolean)
       * - Need the full AST for SQL/Drizzle translation
       *
       * USE THE INPUT PARSER (parseQueryInput) when:
       * - Building autocomplete/suggestions UI
       * - Highlighting key/value in search input as user types
       * - Need position information for cursor-aware features
       * - Handling incomplete input gracefully
       * - Display purposes (values stay as strings)
       *
       * KNOWN DIVERGENCES:
       * 1. Logical keywords as values:
       *    - Main parser REJECTS: status:AND, status:OR, status:NOT
       *    - Input parser ACCEPTS these as valid key:value pairs
       *    - Workaround: Quote the value: status:"AND"
       *
       * 2. Incomplete input:
       *    - Main parser REJECTS: status:, status:done AND
       *    - Input parser returns partial results
       *
       * 3. Quote handling:
       *    - Main parser STRIPS quotes from values
       *    - Input parser PRESERVES quotes (for display)
       *
       * 4. Type conversion:
       *    - Main parser converts to proper types (42 -> number)
       *    - Input parser keeps as strings ("42")
       *
       * 5. Complex syntax (ranges, arrays):
       *    - Main parser fully understands [1 TO 10], [a, b, c]
       *    - Input parser has limited support
       */
      expect(true).toBe(true);
    });
  });
});
