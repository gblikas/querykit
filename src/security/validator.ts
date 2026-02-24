import { IComparisonExpression, QueryExpression } from '../parser/types';
import { DEFAULT_SECURITY_OPTIONS, ISecurityOptions } from './types';

/**
 * Error thrown when a query violates security constraints
 *
 * This error is thrown when a query attempts to bypass security settings
 * such as accessing unauthorized fields, exceeding complexity limits,
 * or using potentially dangerous patterns.
 *
 * @example
 * ```typescript
 * try {
 *   queryValidator.validate(parsedQuery);
 * } catch (error) {
 *   if (error instanceof QuerySecurityError) {
 *     console.error('Security violation:', error.message);
 *     // Return appropriate error response to client
 *   }
 * }
 * ```
 */
export class QuerySecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuerySecurityError';
  }
}

/**
 * Validates query expressions against security constraints
 *
 * The QuerySecurityValidator ensures that queries comply with the security
 * rules defined in the ISecurityOptions. It should be used before executing
 * any query to prevent potential security issues or resource exhaustion.
 *
 * @example
 * ```typescript
 * import { QuerySecurityValidator, ISecurityOptions } from 'querykit';
 * import { parseQuery } from 'querykit/parser';
 *
 * // Define security options
 * const securityOptions: ISecurityOptions = {
 *   allowedFields: ['id', 'name', 'createdAt'],
 *   denyFields: ['password'],
 *   maxQueryDepth: 5
 * };
 *
 * // Create validator
 * const validator = new QuerySecurityValidator(securityOptions);
 *
 * // Use in API endpoint
 * app.get('/users', (req, res) => {
 *   try {
 *     // Parse the query from request
 *     const queryStr = req.query.filter || '';
 *     const parsedQuery = parseQuery(queryStr);
 *
 *     // Validate against security rules
 *     validator.validate(parsedQuery, userSchema);
 *
 *     // If validation passes, execute the query
 *     const results = executeQuery(parsedQuery);
 *     res.json(results);
 *   } catch (error) {
 *     if (error instanceof QuerySecurityError) {
 *       res.status(400).json({ error: error.message });
 *     } else {
 *       res.status(500).json({ error: 'Server error' });
 *     }
 *   }
 * });
 * ```
 */
export class QuerySecurityValidator {
  private options: Required<ISecurityOptions>;

  /**
   * Creates a new QuerySecurityValidator instance
   *
   * @param options - Security options to apply. If not provided, default options will be used.
   *
   * @example
   * ```typescript
   * // Create with default security settings
   * const defaultValidator = new QuerySecurityValidator();
   *
   * // Create with custom security settings
   * const strictValidator = new QuerySecurityValidator({
   *   maxQueryDepth: 3,
   *   maxClauseCount: 10,
   *   maxValueLength: 500
   * });
   * ```
   */
  constructor(options: ISecurityOptions = {}) {
    this.options = {
      ...DEFAULT_SECURITY_OPTIONS,
      ...options
    };
  }

  /**
   * Validate a query expression against security constraints
   *
   * This is the main method that should be called before executing any query.
   * It performs all security checks defined in the options.
   *
   * @param expression - The parsed query expression to validate
   * @param schema - Optional schema definition to validate fields against
   * @throws {QuerySecurityError} If the query violates any security constraints
   *
   * @example
   * ```typescript
   * import { parseQuery } from 'querykit/parser';
   *
   * const validator = new QuerySecurityValidator();
   *
   * // Simple validation
   * try {
   *   const query = parseQuery('user.name == "John" && user.priority > 2');
   *   validator.validate(query);
   *   // Query is safe to execute
   * } catch (error) {
   *   // Handle security violation
   * }
   *
   * // Validation with schema
   * const userSchema = {
   *   user: {
   *     id: 'number',
   *     name: 'string',
   *     priority: 'number',
   *     email: 'string'
   *   }
   * };
   *
   * try {
   *   const query = parseQuery('user.email == "john@example.com"');
   *   validator.validate(query, userSchema);
   *   // Query is safe to execute
   * } catch (error) {
   *   // Handle security violation
   * }
   * ```
   */
  public validate(
    expression: QueryExpression,
    schema?: Record<string, Record<string, unknown>>
  ): void {
    // Check for dot notation if disabled
    if (!this.options.allowDotNotation) {
      this.validateNoDotNotation(expression);
    }

    // Check for field restrictions if specified
    this.validateFields(expression, schema);

    // Check for denied values if specified
    this.validateDenyValues(expression);

    // Check query complexity
    this.validateQueryDepth(expression, 0);
    this.validateClauseCount(expression);

    // Check value lengths
    this.validateValueLengths(expression);

    // Sanitize wildcard patterns if enabled
    if (this.options.sanitizeWildcards) {
      this.sanitizeWildcards(expression);
    }
  }

  /**
   * Validate that query fields are allowed and not denied
   *
   * @private
   * @param expression - The query expression to validate
   * @param schema - Optional schema definition to validate fields against
   */
  private validateFields(
    expression: QueryExpression,
    schema?: Record<string, Record<string, unknown>>
  ): void {
    const fieldSet = new Set<string>();
    this.collectFields(expression, fieldSet);

    // Create a set of allowed fields
    const allowedFields = new Set<string>();

    // If allowedFields is empty and schema is provided, use schema fields
    if (this.options.allowedFields.length === 0 && schema) {
      for (const table in schema) {
        if (typeof schema[table] === 'object') {
          for (const field in schema[table]) {
            allowedFields.add(`${table}.${field}`);
            allowedFields.add(field);
          }
        }
      }
    } else {
      this.options.allowedFields.forEach(field => allowedFields.add(field));
    }

    // Create a set of denied fields
    const deniedFields = new Set<string>(this.options.denyFields);

    // Check each field in the query
    for (const field of fieldSet) {
      // Security fix: Generic error to prevent field enumeration attacks
      if (
        deniedFields.has(field) ||
        (allowedFields.size > 0 && !allowedFields.has(field))
      ) {
        throw new QuerySecurityError('Invalid query parameters');
      }
    }
  }

  /**
   * Validate that field names do not contain dot notation
   *
   * When allowDotNotation is disabled, this method ensures no field names
   * contain dots, which could be used for:
   * - Table-qualified column access (e.g., "users.password")
   * - Nested JSON/JSONB field access (e.g., "metadata.secret")
   * - Probing internal table structures
   *
   * @private
   * @param expression - The query expression to validate
   * @throws {QuerySecurityError} If a field name contains dot notation
   */
  private validateNoDotNotation(expression: QueryExpression): void {
    if (expression.type === 'comparison') {
      const { field } = expression;
      if (field.includes('.')) {
        throw new QuerySecurityError(
          `Dot notation is not allowed in field names. ` +
            `Found "${field}" - use a simple field name without dots instead.`
        );
      }
    } else if (expression.type === 'logical') {
      // Recursively validate logical expressions
      this.validateNoDotNotation(expression.left);
      if (expression.right) {
        this.validateNoDotNotation(expression.right);
      }
    }
    // Raw expressions are skipped - they handle their own field access
  }

  /**
   * Validate that query values are not in the denied values list for their field
   *
   * This method checks each comparison expression to ensure the value being
   * queried is not in the denyValues list for that field. This provides
   * granular control over what values can be queried for specific fields.
   *
   * @private
   * @param expression - The query expression to validate
   * @throws {QuerySecurityError} If a denied value is found in the query
   */
  private validateDenyValues(expression: QueryExpression): void {
    // Skip if no denyValues configured
    if (Object.keys(this.options.denyValues).length === 0) {
      return;
    }

    if (expression.type === 'comparison') {
      const { field, value } = expression;
      const deniedValues = this.options.denyValues[field];

      if (deniedValues && deniedValues.length > 0) {
        // Check if the value is an array (for IN/NOT IN operators)
        if (Array.isArray(value)) {
          for (const item of value) {
            if (this.isValueDenied(item, deniedValues)) {
              throw new QuerySecurityError('Invalid query parameters');
            }
          }
        } else {
          // Single value comparison
          if (this.isValueDenied(value, deniedValues)) {
            throw new QuerySecurityError('Invalid query parameters');
          }
        }
      }
    } else if (expression.type === 'logical') {
      // Recursively validate logical expressions
      this.validateDenyValues(expression.left);
      if (expression.right) {
        this.validateDenyValues(expression.right);
      }
    }
    // Raw expressions are skipped - they handle their own values
  }

  /**
   * Check if a value is in the denied values list
   *
   * @private
   * @param value - The value to check
   * @param deniedValues - The list of denied values
   * @returns true if the value is denied, false otherwise
   */
  private isValueDenied(
    value: string | number | boolean | null,
    deniedValues: Array<string | number | boolean | null>
  ): boolean {
    // Use strict equality to match values, handling type coercion properly
    return deniedValues.some(deniedValue => {
      // Handle null comparison explicitly
      if (value === null && deniedValue === null) {
        return true;
      }
      // Handle same-type comparison with strict equality
      if (typeof value === typeof deniedValue) {
        return value === deniedValue;
      }
      // Handle string/number comparison (common case)
      if (typeof value === 'string' && typeof deniedValue === 'number') {
        return value === String(deniedValue);
      }
      if (typeof value === 'number' && typeof deniedValue === 'string') {
        return String(value) === deniedValue;
      }
      return false;
    });
  }

  /**
   * Validate that query depth does not exceed the maximum
   *
   * @private
   * @param expression - The query expression to validate
   * @param currentDepth - The current depth level in the recursion
   */
  private validateQueryDepth(
    expression: QueryExpression,
    currentDepth: number
  ): void {
    if (currentDepth > this.options.maxQueryDepth) {
      throw new QuerySecurityError(
        `Query exceeds maximum depth of ${this.options.maxQueryDepth}`
      );
    }

    if (expression.type === 'logical') {
      this.validateQueryDepth(expression.left, currentDepth + 1);
      if (expression.right) {
        this.validateQueryDepth(expression.right, currentDepth + 1);
      }
    }
    // Raw and comparison expressions don't add depth
  }

  /**
   * Validate that the number of clauses does not exceed the maximum
   *
   * @private
   * @param expression - The query expression to validate
   */
  private validateClauseCount(expression: QueryExpression): void {
    const count = this.countClauses(expression);
    if (count > this.options.maxClauseCount) {
      throw new QuerySecurityError(
        `Query exceeds maximum clause count of ${this.options.maxClauseCount} (found ${count})`
      );
    }
  }

  /**
   * Count the number of clauses in a query expression
   *
   * @private
   * @param expression - The query expression to count clauses in
   * @returns The total number of comparison clauses
   */
  private countClauses(expression: QueryExpression): number {
    if (expression.type === 'comparison') {
      return 1;
    }

    if (expression.type === 'raw') {
      return 1; // Raw expressions count as one clause
    }

    let count = 0;
    count += this.countClauses(expression.left);
    if (expression.right) {
      count += this.countClauses(expression.right);
    }
    return count;
  }

  /**
   * Validate that string values do not exceed maximum length
   * Security: Enhanced to prevent type confusion attacks via arrays/objects
   *
   * @private
   * @param expression - The query expression to validate
   */
  private validateValueLengths(expression: QueryExpression): void {
    if (expression.type === 'comparison') {
      const { value } = expression;

      // Check string values
      if (
        typeof value === 'string' &&
        value.length > this.options.maxValueLength
      ) {
        throw new QuerySecurityError(
          `Query contains a string value that exceeds maximum length of ${this.options.maxValueLength} characters`
        );
      }

      // Security fix: Enhanced array validation to prevent bypass
      if (Array.isArray(value)) {
        if (value.length > 100) {
          // Limit array size
          throw new QuerySecurityError('Array values cannot exceed 100 items');
        }

        for (const item of value) {
          if (
            typeof item === 'string' &&
            item.length > this.options.maxValueLength
          ) {
            throw new QuerySecurityError(
              `Query contains a string value in array that exceeds maximum length of ${this.options.maxValueLength} characters`
            );
          }

          // Security fix: Prevent object injection in arrays
          if (typeof item === 'object' && item !== null) {
            throw new QuerySecurityError(
              'Object values are not allowed in arrays'
            );
          }
        }
      }

      // Security fix: Prevent object values entirely
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value)
      ) {
        throw new QuerySecurityError('Object values are not allowed');
      }
    } else if (expression.type === 'logical') {
      this.validateValueLengths(expression.left);
      if (expression.right) {
        this.validateValueLengths(expression.right);
      }
    }
    // Raw expressions are skipped - they handle their own values
  }

  /**
   * Sanitize wildcard patterns in LIKE queries to prevent regex DoS
   * Security: Enhanced to prevent ReDoS attacks via catastrophic backtracking
   *
   * @private
   * @param expression - The query expression to sanitize
   */
  private sanitizeWildcards(expression: QueryExpression): void {
    if (expression.type === 'comparison') {
      const { operator, value } = expression;

      // Only sanitize LIKE operators with string values
      if (operator === 'LIKE' && typeof value === 'string') {
        // Security fix: Count wildcards to prevent ReDoS
        const wildcardCount = (value.match(/[*?]/g) || []).length;
        if (wildcardCount > 10) {
          throw new QuerySecurityError('Excessive wildcard usage');
        }

        // Security fix: Prevent alternating patterns that cause catastrophic backtracking
        // Pattern like "*a*b*c*d*e*f" (alternating * and non-* chars)
        if (/(\*[^*]+){5,}/.test(value)) {
          throw new QuerySecurityError('Complex wildcard patterns not allowed');
        }

        // Enhanced sanitization: limit consecutive wildcards
        const sanitized = value
          .replace(/\*{2,}/g, '*') // Limit consecutive asterisks
          .replace(/\?{2,}/g, '?'); // Limit consecutive question marks
        (expression as IComparisonExpression).value = sanitized;
      }
    } else if (expression.type === 'logical') {
      this.sanitizeWildcards(expression.left);
      if (expression.right) {
        this.sanitizeWildcards(expression.right);
      }
    }
    // Raw expressions are skipped - they handle their own wildcards
  }

  /**
   * Collect all field names used in the query
   *
   * @private
   * @param expression - The query expression to collect fields from
   * @param fieldSet - Set to store the collected field names
   */
  private collectFields(
    expression: QueryExpression,
    fieldSet: Set<string>
  ): void {
    if (expression.type === 'comparison') {
      fieldSet.add(expression.field);
    } else if (expression.type === 'logical') {
      this.collectFields(expression.left, fieldSet);
      if (expression.right) {
        this.collectFields(expression.right, fieldSet);
      }
    }
    // Raw expressions don't expose field names for collection
  }
}
