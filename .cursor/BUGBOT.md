# Project review guidelines

Below is a list of generally accepted best-practices to prevent bugs in QueryKit. Not all guidelines may apply to every component; please make sure to read the README.md for context on the project's goals.

## Security focus areas

- Validate user input in API endpoints
- Check for SQL injection vulnerabilities in database queries
- Ensure proper authentication on protected routes
- Validate query inputs using `parseWithContext` with security options
- Use `allowedFields` and `denyFields` to restrict queryable fields
- Set `maxQueryDepth` and `maxClauseCount` to prevent DoS attacks

### Query parsing security

When using the input parser or `parseWithContext`:

1. **Never trust user-provided queries** - Always validate with security options:
   ```typescript
   const result = parser.parseWithContext(userQuery, {
     securityOptions: {
       allowedFields: ['name', 'status', 'priority'],
       denyFields: ['password', 'secret'],
       maxQueryDepth: 5,
       maxClauseCount: 20
     }
   });
   
   if (!result.security?.passed) {
     // Reject query - contains violations
   }
   ```

2. **Schema validation** - Use schema to detect typos and invalid fields early:
   ```typescript
   const result = parser.parseWithContext(userQuery, { schema });
   if (!result.fieldValidation?.valid) {
     // Show user-friendly error with suggestions
   }
   ```

3. **Input parser limitations** - The input parser (`parseQueryInput`, `parseQueryTokens`) is regex-based for performance. It may accept inputs that the main parser rejects. Always validate with `parseWithContext` or `parser.parse()` before executing queries.

## Architecture patterns

- Use dependency injection for services
- Follow the repository pattern for data access
- Implement proper error handling with custom error classes
- Parser components follow Single Responsibility Principle:
  - `input-parser.ts` - Fast, regex-based tokenization for UI feedback
  - `parser.ts` - Full Liqe-based parsing with AST generation
  - `parseWithContext` - Orchestrates both for rich context

### Parser architecture

The parsing system has two tiers:

1. **Input Parser** (`parseQueryInput`, `parseQueryTokens`)
   - Purpose: Real-time UI feedback (highlighting, cursor context)
   - Performance: O(n) regex-based, no AST generation
   - Error handling: Best-effort, never throws
   - Use for: Search bar highlighting, autocomplete triggering

2. **Query Parser** (`parser.parse`, `parseWithContext`)
   - Purpose: Query validation and execution
   - Performance: Full Liqe grammar parsing
   - Error handling: Strict validation, detailed error messages
   - Use for: Query execution, security validation

## Common issues

- Memory leaks in React components (check useEffect cleanup)
- Missing error boundaries in UI components
- Inconsistent naming conventions (use camelCase for functions)
- Not checking `result.success` before accessing `result.ast`
- Using input parser for security validation (use `parseWithContext` instead)
- Forgetting to provide `cursorPosition` when autocomplete is needed

## Testing guidelines

- All parser features require co-located tests
- Use divergence tests to document differences between input parser and main parser
- Token consistency tests verify `parseWithContext` tokens match `parseQueryTokens`
- Security tests should cover field restrictions, depth limits, and value sanitization