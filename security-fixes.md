# Security Fixes for QueryKit LIQE Parser

This document provides specific code fixes for each identified vulnerability.

## VULN-001: SQL Injection via Raw SQL Construction

**Fix**: Enhance field name validation and SQL identifier escaping

```typescript
// src/translators/drizzle/index.ts - Add safe identifier handling
private buildSqlForOperator(fieldName: string, operator: string, value: unknown): SQL {
  // Validate field name format before using it
  if (!this.isValidFieldName(fieldName)) {
    throw new DrizzleTranslationError(`Invalid field name: ${fieldName}`);
  }
  
  switch (operator) {
    case '==':
      // Use sql.name() for safer identifier handling
      return sql`${sql.name(fieldName)} = ${value}`;
    case '!=':
      return sql`${sql.name(fieldName)} != ${value}`;
    // ... other operators
  }
}

private isValidFieldName(fieldName: string): boolean {
  // Only allow alphanumeric, dots, and underscores
  const validFieldPattern = /^[a-zA-Z][a-zA-Z0-9._]*$/;
  
  // Check each part if it contains dots (table.column format)
  const parts = fieldName.split('.');
  if (parts.length > 2) return false; // Only table.column allowed
  
  return parts.every(part => 
    validFieldPattern.test(part) && 
    part.length <= 64 && // Reasonable length limit
    !part.includes('__') // Prevent reserved patterns
  );
}
```

## VULN-002: Field Enumeration via Error Messages

**Fix**: Normalize error messages to prevent field enumeration

```typescript
// src/security/validator.ts - Update validateFields method
private validateFields(
  expression: QueryExpression,
  schema?: Record<string, Record<string, unknown>>
): void {
  const fieldSet = new Set<string>();
  this.collectFields(expression, fieldSet);

  // Create sets as before...
  
  // Check each field in the query
  for (const field of fieldSet) {
    if (
      deniedFields.has(field) ||
      (allowedFields.size > 0 && !allowedFields.has(field))
    ) {
      // Generic error message to prevent enumeration
      throw new QuerySecurityError('Invalid query parameters');
    }
  }
}
```

## VULN-003: ReDoS via Wildcard Patterns

**Fix**: Enhanced wildcard pattern sanitization

```typescript
// src/security/validator.ts - Improve sanitizeWildcards method
private sanitizeWildcards(expression: QueryExpression): void {
  if (expression.type === 'comparison') {
    const { operator, value } = expression;

    if (operator === 'LIKE' && typeof value === 'string') {
      // Count wildcards to prevent ReDoS
      const wildcardCount = (value.match(/[*?]/g) || []).length;
      if (wildcardCount > 10) {
        throw new QuerySecurityError('Excessive wildcard usage');
      }
      
      // Prevent alternating patterns that cause catastrophic backtracking
      if (/(\*[^*]*){5,}/.test(value)) {
        throw new QuerySecurityError('Complex wildcard patterns not allowed');
      }
      
      // Enhanced sanitization
      const sanitized = value
        .replace(/\*{2,}/g, '*')  // Limit consecutive asterisks
        .replace(/\?{2,}/g, '?'); // Limit consecutive question marks
        
      (expression as IComparisonExpression).value = sanitized;
    }
  } else {
    this.sanitizeWildcards(expression.left);
    if (expression.right) {
      this.sanitizeWildcards(expression.right);
    }
  }
}
```

## VULN-004: Logic Bypass via Type Confusion

**Fix**: Enhanced value validation in security validator

```typescript
// src/security/validator.ts - Add comprehensive value validation
private validateValueLengths(expression: QueryExpression): void {
  if (expression.type === 'comparison') {
    const { value } = expression;

    // Check string values
    if (typeof value === 'string' && value.length > this.options.maxValueLength) {
      throw new QuerySecurityError(
        `Query contains a string value that exceeds maximum length of ${this.options.maxValueLength} characters`
      );
    }

    // Check array values - NEW
    if (Array.isArray(value)) {
      if (value.length > 100) { // Limit array size
        throw new QuerySecurityError('Array values cannot exceed 100 items');
      }
      
      for (const item of value) {
        if (typeof item === 'string' && item.length > this.options.maxValueLength) {
          throw new QuerySecurityError(
            `Query contains a string value in array that exceeds maximum length of ${this.options.maxValueLength} characters`
          );
        }
        
        // Prevent object injection in arrays
        if (typeof item === 'object' && item !== null) {
          throw new QuerySecurityError('Object values are not allowed in arrays');
        }
      }
    }
    
    // Prevent object values entirely - NEW
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      throw new QuerySecurityError('Object values are not allowed');
    }
  } else {
    this.validateValueLengths(expression.left);
    if (expression.right) {
      this.validateValueLengths(expression.right);
    }
  }
}
```

## VULN-005: NoSQL Injection via Object Values

**Fix**: Strict type checking in parser

```typescript
// src/parser/parser.ts - Update convertLiqeValue method
private convertLiqeValue(value: unknown): QueryValue {
  // Strict type checking to prevent object injection
  if (value === null) {
    return null;
  }
  
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as QueryValue;
  }
  
  if (Array.isArray(value)) {
    // Recursively validate array elements
    const validatedArray = value.map(item => {
      if (typeof item === 'object' && item !== null) {
        throw new QueryParseError('Object values are not allowed in arrays');
      }
      return this.convertLiqeValue(item);
    });
    return validatedArray as QueryValue;
  }
  
  // Reject all object types
  if (typeof value === 'object') {
    throw new QueryParseError('Object values are not supported for security reasons');
  }

  throw new QueryParseError(`Unsupported value type: ${typeof value}`);
}
```

## Additional Security Enhancements

### 1. Rate Limiting for Query Complexity

```typescript
// src/security/types.ts - Add rate limiting options
export interface ISecurityOptions {
  // ... existing options
  
  /**
   * Maximum number of queries per minute per client
   */
  maxQueriesPerMinute?: number;
  
  /**
   * Enable query complexity scoring
   */
  enableComplexityScoring?: boolean;
  
  /**
   * Maximum complexity score allowed
   */
  maxComplexityScore?: number;
}

// src/security/validator.ts - Add complexity scoring
private calculateComplexityScore(expression: QueryExpression): number {
  if (expression.type === 'comparison') {
    let score = 1;
    
    // LIKE operations are more expensive
    if (expression.operator === 'LIKE') {
      score += 2;
      // Wildcard patterns increase complexity
      if (typeof expression.value === 'string') {
        score += (expression.value.match(/[*?]/g) || []).length;
      }
    }
    
    return score;
  }
  
  // Logical operations add complexity
  let score = 1;
  score += this.calculateComplexityScore(expression.left);
  if (expression.right) {
    score += this.calculateComplexityScore(expression.right);
  }
  
  return score;
}
```

### 2. Query Logging and Monitoring

```typescript
// src/security/logger.ts - New file for security logging
export class SecurityLogger {
  static logSuspiciousQuery(query: string, reason: string, clientInfo?: any): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      type: 'SUSPICIOUS_QUERY',
      query: query.substring(0, 200), // Truncate for logging
      reason,
      clientInfo: {
        ip: clientInfo?.ip || 'unknown',
        userAgent: clientInfo?.userAgent || 'unknown'
      }
    };
    
    console.warn('[SECURITY]', JSON.stringify(logEntry));
    
    // In production, send to security monitoring system
    // this.sendToSecuritySystem(logEntry);
  }
  
  static logQueryExecution(query: string, executionTime: number): void {
    if (executionTime > 5000) { // Log slow queries
      const logEntry = {
        timestamp: new Date().toISOString(),
        type: 'SLOW_QUERY',
        query: query.substring(0, 200),
        executionTime
      };
      
      console.warn('[PERFORMANCE]', JSON.stringify(logEntry));
    }
  }
}
```

### 3. Content Security Policy for LIKE Patterns

```typescript
// src/translators/drizzle/index.ts - Add LIKE pattern validation
private wildcardToSqlPattern(pattern: string): string {
  // Validate pattern before conversion
  if (pattern.length > 100) {
    throw new DrizzleTranslationError('LIKE pattern too long');
  }
  
  // Count wildcards
  const wildcardCount = (pattern.match(/[%_*?]/g) || []).length;
  if (wildcardCount > 10) {
    throw new DrizzleTranslationError('Too many wildcards in pattern');
  }
  
  // Check for patterns that might cause performance issues
  if (/(%[^%]*){5,}/.test(pattern) || /(_[^_]*){10,}/.test(pattern)) {
    throw new DrizzleTranslationError('Complex patterns not allowed');
  }
  
  return pattern
    .replace(/%/g, '\\%')   // Escape existing %
    .replace(/_/g, '\\_')   // Escape existing _
    .replace(/\*/g, '%')    // * → %
    .replace(/\?/g, '_');   // ? → _
}
```

## Testing Enhancements

### Security Test Suite

```typescript
// tests/security.test.ts - New comprehensive security tests
describe('Security Tests', () => {
  describe('SQL Injection Prevention', () => {
    it('should reject malicious field names', () => {
      const maliciousQueries = [
        'user.name; DROP TABLE users; --:"test"',
        'id\'; DELETE FROM users; --:"1"',
        'name` OR 1=1; --:"admin"'
      ];
      
      maliciousQueries.forEach(query => {
        expect(() => parser.parse(query)).toThrow();
      });
    });
  });
  
  describe('ReDoS Prevention', () => {
    it('should reject catastrophic backtracking patterns', () => {
      const redosPatterns = [
        'name:"*a*a*a*a*a*a*a*a*a*a*b"',
        'title:"?x?x?x?x?x?x?x?x?x?x?y"'
      ];
      
      redosPatterns.forEach(pattern => {
        const parsed = parser.parse(pattern);
        expect(() => validator.validate(parsed)).toThrow();
      });
    });
  });
  
  describe('Type Confusion Prevention', () => {
    it('should reject object values', () => {
      const objectQueries = [
        'field:{"$ne": null}',
        'status:[{"test": "value"}]'
      ];
      
      objectQueries.forEach(query => {
        expect(() => parser.parse(query)).toThrow();
      });
    });
  });
});
```

These fixes address the core security vulnerabilities while maintaining functionality and providing clear upgrade paths.