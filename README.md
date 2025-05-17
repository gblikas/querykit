# QueryKit

QueryKit is a modern query toolkit for Lucene-style search, designed to give developers a head-start for dynamic search. QueryKit simplifies how you build and execute fielded searchs across different databases and ORMs. It provides a unified, intuitive SDK for filtering, sorting, and transforming data, and handles the heavy lifting of parsing and translating those queries to your data source. 

## What Does QueryKit Do?

QueryKit allows developers to define queries in a high-level, readable format and then run those queries anywhere (in the browser, on the server, or via CLI). Instead of writing different query logic for each layer of your stack, you can use QueryKit's consistent API to:

- **Filter and sort data with a Lucene-like query language** – For example, `status:done AND in:todos`. 

- **Translate high-level queries to concrete implementations** – QueryKit takes your schema definition and converts it into the appropriate form for the environment. 

- **Unify front‑end and back‑end filtering logic** – The same QueryKit query can be run in a front-end app for client-side filtering or on a server for database queries. This ensures consistency in how data is filtered across your application.

## Quick Start

Below are various examples of how to use QueryKit.

**Drizzle ORM**

```typescript

// schema.ts
import { serial, text, pgTable } from 'drizzle-orm/pg-core';
import { type InferSelectModel, type InferInsertModel } from 'drizzle-orm'

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('draft')
});

type SelectUser = InferSelectModel<typeof users>;

// example.ts
import { SelectUser } from './schema';
import { createQueryKit } from 'querykit';
import { drizzleAdapter } from 'querykit/adapters/drizzle';

// Create a QueryKit instance with Drizzle adapter
const qk = createQueryKit({
  adapter: drizzleAdapter,
  schema: { users },
});

// Build a query using the Lucene-like query syntax
const query = qk.query('users')
  .where('status:done AND name:"John *"')
  .orderBy('name', 'asc')
  .limit(10);

// Execute the query against your database
const results = await query.execute();
```

## Query Syntax

QueryKit uses Liqe Query Language (LQL), which is a Lucene-like syntax for filtering data:

```
# Basic field queries
status:active         # Field equals value (case insensitive)
status:"Active"       # Field equals value (case sensitive)

# Comparison operators
priority:>2               # Greater than
priority:>=2              # Greater than or equal
priority:<2               # Less than
priority:<=2              # Less than or equal
priority:=2               # Exact equals

# Ranges
dueDate:[2023-01-01 TO 2023-01-31]      # Inclusive range
dueDate:{2023-01-01 TO 2023-01-31}      # Exclusive range

# Pattern matching
name:/Todo.*/         # Regular expression
title:intro*          # Wildcard matching

# Boolean operators
status:active AND priority:>2     # AND operator
status:active OR status:pending   # OR operator
NOT expired:true      # NOT operator
-expired:true         # Alternative NOT syntax

# Grouping
(status:active OR status:pending) AND priority:<3

# Implicit AND (space between expressions)
status:active priority:>2
```

## Installation

```bash
npm install querykit
```

## Dependencies

QueryKit leverages several key dependencies to provide its functionality:

- [**Liqe**](https://github.com/gajus/liqe): A lightweight and performant Lucene-like parser, serializer, and search engine. QueryKit uses Liqe for parsing the query syntax into an abstract syntax tree (AST) that can then be translated to various target languages.

- [**Drizzle ORM**](https://github.com/drizzle-team/drizzle-orm): A TypeScript ORM that's used for SQL database interactions. QueryKit's Drizzle adapter translates queries into Drizzle ORM queries.

Additional dependencies will be added as the project evolves.

## Security Features

QueryKit provides configurable security guardrails to protect your database from potentially harmful queries while maintaining flexibility. These features can be configured during initialization:

> **IMPORTANT DISCLAIMER**: While QueryKit provides guardrails to help protect against common query-related vulnerabilities, it is not a comprehensive security solution. These features are provided as helpful tools, not guarantees. You are still responsible for implementing proper authentication, authorization, and other security measures in your application. QueryKit does not guarantee protection against all forms of database attacks or query exploits.

```typescript
import { createQueryKit } from 'querykit';
import { drizzleAdapter } from 'querykit/adapters/drizzle';

const qk = createQueryKit({
  adapter: drizzleAdapter,
  schema: { users },
  security: {
    // Field restrictions
    allowedFields: ['name', 'email', 'priority', 'status'], // Only these fields can be queried
    denyFields: ['password', 'secretKey'],            // These fields can never be queried
    
    // Query complexity limits
    maxQueryDepth: 5,          // Maximum nesting level of expressions
    maxClauseCount: 20,        // Maximum number of clauses (AND/OR operations)
    
    // Resource protection
    defaultLimit: 100,         // Default result limit if none specified
    maxLimit: 1000,            // Maximum allowed limit for pagination
    
    // Value sanitization
    maxValueLength: 100,       // Maximum string length for query values
    sanitizeWildcards: true,   // Prevent regex DoS with wildcards in LIKE queries
    
    // Performance safeguards
    queryTimeout: 5000,        // Timeout in milliseconds for query execution
  }
});
```

By default, QueryKit applies sensible security defaults even without explicit configuration:

```typescript
// Default security configuration
const DEFAULT_SECURITY = {
  // Field restrictions - by default, all schema fields are allowed
  allowedFields: [],           // Empty means "use schema fields"
  denyFields: [],              // Empty means no denied fields
  
  // Query complexity limits
  maxQueryDepth: 10,           // Maximum nesting level of expressions
  maxClauseCount: 50,          // Maximum number of clauses (AND/OR operations)
  
  // Resource protection
  defaultLimit: 100,           // Default result limit if none specified
  maxLimit: 1000,              // Maximum allowed limit for pagination
  
  // Value sanitization
  maxValueLength: 1000,        // Maximum string length for query values
  sanitizeWildcards: true,     // Prevent regex DoS with wildcards in LIKE queries
  
  // Performance safeguards
  queryTimeout: 30000,         // 30 second timeout by default
}
```

Security configurations can be stored in a separate file and imported:

```typescript
// security-config.json
{
  "allowedFields": ["name", "email", "priority", "status"],
  "maxQueryDepth": 5,
  "maxClauseCount": 20,
  "defaultLimit": 100
}

// In your app
import securityConfig from './security-config.json';

const qk = createQueryKit({
  adapter: drizzleAdapter,
  schema: { users },
  security: securityConfig
});
```

### Additional Security Recommendations

When using QueryKit in production, consider these additional security practices:

1. **Implement Authentication and Authorization**: QueryKit doesn't handle auth - integrate with your existing auth system.
2. **Use Rate Limiting**: Limit the number of queries a user can make in a given time period.
3. **Audit Logging**: Log all queries for security monitoring and debugging.
4. **Field-Level Access Control**: Use dynamic allowedFields based on user roles/permissions.
5. **Separate Query Context**: Consider separate QueryKit instances with different security settings for different contexts (admin vs. user).

## Roadmap

### Core Parsing Engine and DSL
- [x] Implement Lucene-style query syntax parser using Liqe
- [x] Create type-safe query building API
- [x] Develop internal AST representation
- [x] Implement consistent syntax for logical operators (AND, OR, NOT)
- [x] Support standard comparison operators (==, !=, >, >=, <, <=)

### First Adapters
- [x] Drizzle ORM integration
- [x] Implement SQL translation layer
- [ ] In-memory JavaScript filtering
- [x] Query validation and error handling
- [x] Support for schema-aware queries

### Advanced Features
- [ ] CLI tools for testing and debugging
- [x] Performance optimizations for SQL generation
- [x] Support for complex nested expressions
- [ ] Custom function support
- [ ] Pagination helpers

### Ecosystem Expansion
- [ ] Frontend query builder components
- [ ] Additional ORM adapters
- [ ] Server middleware for Express/Fastify
- [ ] TypeScript SDK generation

## Contributing

See the [CONTRIBUTING.md](CONTRIBUTING.md) file for details on how to get started.

## License

This project is licensed under the GPL License - see the [LICENSE](LICENSE) file for details. 