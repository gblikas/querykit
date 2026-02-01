/**
 * Input Parser for QueryKit
 *
 * This module provides utilities for parsing partial/in-progress query input
 * from search bars, enabling features like:
 * - Key-value highlighting
 * - Autocomplete suggestions
 * - Real-time validation feedback
 */

/**
 * Represents the context of where the cursor is within a query term
 */
export type CursorContext = 'key' | 'operator' | 'value' | 'empty' | 'between';

/**
 * Represents the parsed context of a single query term
 */
export interface IQueryInputTerm {
  /**
   * The field/key being typed (e.g., "status" in "status:done")
   * Will be null if only a bare value is being typed
   */
  key: string | null;

  /**
   * The operator being used (e.g., ":", ">", ">=", "<", "<=", "!=")
   * Will be null if no operator has been typed yet
   */
  operator: string | null;

  /**
   * The value being typed (e.g., "done" in "status:done")
   * Will be null if no value has been typed yet
   */
  value: string | null;

  /**
   * The start position of this term in the original input string
   */
  startPosition: number;

  /**
   * The end position of this term in the original input string
   */
  endPosition: number;

  /**
   * The original raw text of this term
   */
  raw: string;
}

/**
 * Represents the result of parsing query input
 */
export interface IQueryInputContext {
  /**
   * All terms found in the input
   */
  terms: IQueryInputTerm[];

  /**
   * The term where the cursor is currently positioned (if cursorPosition was provided)
   * Will be null if cursor is not within any term
   */
  activeTerm: IQueryInputTerm | null;

  /**
   * Where the cursor is within the active term
   */
  cursorContext: CursorContext;

  /**
   * The original input string
   */
  input: string;

  /**
   * The cursor position (if provided)
   */
  cursorPosition: number | null;

  /**
   * Logical operators found between terms (AND, OR, NOT)
   */
  logicalOperators: Array<{
    operator: string;
    position: number;
  }>;
}

/**
 * Options for parsing query input
 */
export interface IQueryInputParserOptions {
  /**
   * Whether to treat the input as case-insensitive for keys
   * @default false
   */
  caseInsensitiveKeys?: boolean;
}

/**
 * Regular expression patterns for parsing
 */
const PATTERNS = {
  // Matches logical operators (AND, OR, NOT) with word boundaries
  LOGICAL_OPERATOR: /\b(AND|OR|NOT)\b/gi,

  // Matches comparison operators: :, :>, :>=, :<, :<=, :!=, :=
  COMPARISON_OPERATOR: /^(:>=|:<=|:!=|:>|:<|:=|:)/,

  // Matches a quoted string (single or double quotes)
  QUOTED_STRING: /^(["'])(?:\\.|[^\\])*?\1/,

  // Matches word characters and some special chars (for keys/values)
  WORD_CHARS: /^[a-zA-Z0-9_.-]+/,

  // Matches whitespace
  WHITESPACE: /^\s+/,

  // Matches parentheses
  PAREN_OPEN: /^\(/,
  PAREN_CLOSE: /^\)/,

  // Matches negation prefix
  NEGATION: /^-/
};

/**
 * Parse a single term (key:value, key:>value, or just value)
 */
function parseTerm(
  input: string,
  startPosition: number
): IQueryInputTerm | null {
  if (!input || input.length === 0) {
    return null;
  }

  let key: string | null = null;
  let operator: string | null = null;
  let value: string | null = null;
  let remaining = input;
  let currentPos = 0;

  // Handle negation prefix (e.g., -status:active)
  let hasNegation = false;
  const negationMatch = remaining.match(PATTERNS.NEGATION);
  if (negationMatch) {
    hasNegation = true;
    remaining = remaining.substring(1);
    currentPos += 1;
  }

  // Try to match a key (word before operator)
  const keyMatch = remaining.match(PATTERNS.WORD_CHARS);
  if (keyMatch) {
    const potentialKey = keyMatch[0];
    const afterKey = remaining.substring(potentialKey.length);

    // Check if followed by an operator
    const operatorMatch = afterKey.match(PATTERNS.COMPARISON_OPERATOR);
    if (operatorMatch) {
      // This is a key:value pattern
      key = (hasNegation ? '-' : '') + potentialKey;
      operator = operatorMatch[0];
      currentPos += potentialKey.length + operator.length;
      remaining = afterKey.substring(operator.length);

      // Try to match the value
      // First check for quoted string
      const quotedMatch = remaining.match(PATTERNS.QUOTED_STRING);
      if (quotedMatch) {
        value = quotedMatch[0];
        currentPos += value.length;
      } else {
        // Match unquoted value (until whitespace or logical operator)
        const valueMatch = remaining.match(/^[^\s()]+/);
        if (valueMatch) {
          value = valueMatch[0];
          currentPos += value.length;
        } else {
          // Operator present but no value yet
          value = null;
        }
      }
    } else {
      // No operator - this is a bare value (or incomplete key)
      // Treat the whole thing as a potential key that could become key:value
      // or as a bare value for full-text search
      key = null;
      operator = null;
      value = (hasNegation ? '-' : '') + potentialKey;
      currentPos += potentialKey.length;
    }
  } else {
    // Check for quoted string as bare value
    const quotedMatch = remaining.match(PATTERNS.QUOTED_STRING);
    if (quotedMatch) {
      key = null;
      operator = null;
      value = (hasNegation ? '-' : '') + quotedMatch[0];
      currentPos += quotedMatch[0].length;
    } else {
      // No recognizable token
      return null;
    }
  }

  return {
    key,
    operator,
    value,
    startPosition,
    endPosition: startPosition + currentPos,
    raw: input.substring(0, currentPos)
  };
}

/**
 * Tokenize the input string into terms and logical operators
 */
function tokenize(input: string): {
  terms: IQueryInputTerm[];
  logicalOperators: Array<{ operator: string; position: number }>;
} {
  const terms: IQueryInputTerm[] = [];
  const logicalOperators: Array<{ operator: string; position: number }> = [];

  let remaining = input;
  let position = 0;

  while (remaining.length > 0) {
    // Skip whitespace
    const wsMatch = remaining.match(PATTERNS.WHITESPACE);
    if (wsMatch) {
      position += wsMatch[0].length;
      remaining = remaining.substring(wsMatch[0].length);
      continue;
    }

    // Skip parentheses (they're structural, not terms)
    if (remaining.match(PATTERNS.PAREN_OPEN)) {
      position += 1;
      remaining = remaining.substring(1);
      continue;
    }
    if (remaining.match(PATTERNS.PAREN_CLOSE)) {
      position += 1;
      remaining = remaining.substring(1);
      continue;
    }

    // Check for logical operators
    const logicalMatch = remaining.match(/^(AND|OR|NOT)\b/i);
    if (logicalMatch) {
      logicalOperators.push({
        operator: logicalMatch[0].toUpperCase(),
        position
      });
      position += logicalMatch[0].length;
      remaining = remaining.substring(logicalMatch[0].length);
      continue;
    }

    // Try to parse a term
    const term = parseTerm(remaining, position);
    if (term) {
      terms.push(term);
      position = term.endPosition;
      remaining = input.substring(position);
    } else {
      // Skip unknown character
      position += 1;
      remaining = remaining.substring(1);
    }
  }

  return { terms, logicalOperators };
}

/**
 * Determine the cursor context based on position within a term
 */
function determineCursorContext(
  term: IQueryInputTerm,
  cursorPosition: number
): CursorContext {
  const relativePos = cursorPosition - term.startPosition;

  if (term.key !== null && term.operator !== null) {
    // Key and operator are present
    const keyLength = term.key.length;
    const operatorLength = term.operator.length;
    const keyPlusOperatorLength = keyLength + operatorLength;

    if (relativePos < keyLength) {
      return 'key';
    } else if (relativePos < keyPlusOperatorLength) {
      return 'operator';
    } else {
      // Cursor is at or after the operator - this is the value position
      // Even if value is null (user hasn't typed anything yet),
      // they're positioned to type a value
      return 'value';
    }
  } else if (term.key !== null) {
    // Only key present (incomplete term)
    return 'key';
  } else if (term.value !== null) {
    // Only value present (bare value)
    return 'value';
  }

  return 'empty';
}

/**
 * Find the term that contains the cursor position
 */
function findActiveTermAndContext(
  terms: IQueryInputTerm[],
  cursorPosition: number | null,
  inputLength: number
): { activeTerm: IQueryInputTerm | null; cursorContext: CursorContext } {
  if (cursorPosition === null) {
    // If no cursor position provided, use the last term
    if (terms.length > 0) {
      const lastTerm = terms[terms.length - 1];
      return {
        activeTerm: lastTerm,
        cursorContext: determineCursorContext(lastTerm, lastTerm.endPosition)
      };
    }
    return { activeTerm: null, cursorContext: 'empty' };
  }

  // Find term containing cursor
  for (const term of terms) {
    if (
      cursorPosition >= term.startPosition &&
      cursorPosition <= term.endPosition
    ) {
      return {
        activeTerm: term,
        cursorContext: determineCursorContext(term, cursorPosition)
      };
    }
  }

  // Cursor is between terms or at the end
  if (cursorPosition >= inputLength && terms.length > 0) {
    // Cursor at the end - check if right after a term
    const lastTerm = terms[terms.length - 1];
    if (cursorPosition === lastTerm.endPosition) {
      return {
        activeTerm: lastTerm,
        cursorContext: determineCursorContext(lastTerm, cursorPosition)
      };
    }
  }

  return { activeTerm: null, cursorContext: 'between' };
}

/**
 * Parse query input to extract structured information about the current search state.
 *
 * This function is designed for real-time parsing of user input in a search bar,
 * allowing developers to:
 * - Highlight keys and values differently
 * - Provide autocomplete suggestions based on context
 * - Validate input as the user types
 *
 * @param input The current search input string
 * @param cursorPosition Optional cursor position to determine the active term
 * @param options Optional parsing options
 * @returns Structured information about the query input
 *
 * @example
 * ```typescript
 * // User is typing "status:d" (intending to type "status:done")
 * const result = parseQueryInput('status:d');
 * // result.terms[0] = { key: 'status', operator: ':', value: 'd', ... }
 * // result.activeTerm = { key: 'status', operator: ':', value: 'd', ... }
 * // result.cursorContext = 'value'
 *
 * // User is typing "priority:>2 status:"
 * const result = parseQueryInput('priority:>2 status:', 19);
 * // result.terms[0] = { key: 'priority', operator: ':>', value: '2', ... }
 * // result.terms[1] = { key: 'status', operator: ':', value: null, ... }
 * // result.activeTerm = result.terms[1] (cursor is at position 19)
 * // result.cursorContext = 'value' (waiting for value input)
 * ```
 */
export function parseQueryInput(
  input: string,
  cursorPosition?: number,
  options?: IQueryInputParserOptions
): IQueryInputContext {
  // Handle empty input
  if (!input || input.trim().length === 0) {
    return {
      terms: [],
      activeTerm: null,
      cursorContext: 'empty',
      input,
      cursorPosition: cursorPosition ?? null,
      logicalOperators: []
    };
  }

  // Tokenize the input
  const { terms, logicalOperators } = tokenize(input);

  // Apply case-insensitivity to keys if requested
  if (options?.caseInsensitiveKeys) {
    for (const term of terms) {
      if (term.key !== null) {
        term.key = term.key.toLowerCase();
      }
    }
  }

  // Find active term and cursor context
  const { activeTerm, cursorContext } = findActiveTermAndContext(
    terms,
    cursorPosition ?? null,
    input.length
  );

  return {
    terms,
    activeTerm,
    cursorContext,
    input,
    cursorPosition: cursorPosition ?? null,
    logicalOperators
  };
}

/**
 * Get the term at a specific cursor position.
 * Convenience function for quick lookups.
 *
 * @param input The query input string
 * @param cursorPosition The cursor position
 * @returns The term at the cursor position, or null if none
 */
export function getTermAtPosition(
  input: string,
  cursorPosition: number
): IQueryInputTerm | null {
  const result = parseQueryInput(input, cursorPosition);
  return result.activeTerm;
}

/**
 * Check if the input appears to be a complete, valid query expression.
 * This is a lightweight check - it doesn't guarantee the query will parse successfully.
 *
 * @param input The query input string
 * @returns true if the input appears complete, false if it looks incomplete
 */
export function isInputComplete(input: string): boolean {
  if (!input || input.trim().length === 0) {
    return false;
  }

  const result = parseQueryInput(input);

  // Check if any term is incomplete
  for (const term of result.terms) {
    // A key:value term is incomplete if it has an operator but no value
    if (term.key !== null && term.operator !== null && term.value === null) {
      return false;
    }
  }

  // Check if the input ends with a logical operator
  const trimmed = input.trim();
  if (/\b(AND|OR|NOT)\s*$/i.test(trimmed)) {
    return false;
  }

  // Check if there's an unclosed quote
  const singleQuotes = (input.match(/'/g) || []).length;
  const doubleQuotes = (input.match(/"/g) || []).length;
  if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
    return false;
  }

  // Check for unclosed parentheses
  const openParens = (input.match(/\(/g) || []).length;
  const closeParens = (input.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    return false;
  }

  return true;
}

/**
 * Extract just the key and value from a simple input.
 * Convenience function for the most common use case.
 *
 * @param input The query input string (e.g., "status:done")
 * @returns Object with key and value, or null if not a key:value pattern
 *
 * @example
 * ```typescript
 * extractKeyValue('status:done');
 * // { key: 'status', value: 'done' }
 *
 * extractKeyValue('status:');
 * // { key: 'status', value: null }
 *
 * extractKeyValue('hello');
 * // null (no key:value pattern)
 * ```
 */
export function extractKeyValue(
  input: string
): { key: string; value: string | null } | null {
  const result = parseQueryInput(input.trim());

  if (result.terms.length === 0) {
    return null;
  }

  const term = result.terms[0];

  if (term.key === null) {
    return null;
  }

  return {
    key: term.key,
    value: term.value
  };
}
