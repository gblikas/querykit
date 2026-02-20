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
    
    // Value restrictions - deny specific values for fields
    denyValues: {
      status: ['deleted', 'banned'],      // Block queries for deleted/banned records
      role: ['superadmin', 'system'],     // Prevent querying privileged roles
      'user.type': ['internal', 'bot']    // Supports dot-notation for nested fields
    },
    
    // Field name restrictions
    allowDotNotation: true,    // Set to false to block "table.field" or "json.path" queries
    
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
  denyValues: {},              // Empty means no denied values for any field
  allowDotNotation: true,      // Allow "table.field" and "json.path" notation
  
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
  "denyValues": {
    "status": ["deleted", "banned"],
    "role": ["superadmin", "system"]
  },
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

### Controlling Dot Notation in Field Names

QueryKit supports dot notation in field names (e.g., `user.name`, `metadata.tags`) which is useful for:

- **Table-qualified columns**: When joining tables with overlapping column names (`users.id` vs `orders.id`)
- **JSON/JSONB fields**: Querying nested data in PostgreSQL JSON columns (`metadata.dimensions.width`)
- **Related data**: Accessing data through ORM relations (`order.customer.name`)

However, you may want to **disable dot notation** for public-facing APIs:

```typescript
const qk = createQueryKit({
  adapter: drizzleAdapter,
  schema: { products },
  security: {
    allowDotNotation: false,  // Reject queries like "user.password" or "config.secret"
    allowedFields: ['name', 'price', 'category', 'inStock']
  }
});

// ✅ Allowed: Simple field names
qk.query('products').where('name:"Widget" AND price:<100');

// ❌ Rejected: Dot notation
qk.query('products').where('user.password:"secret"');
// Error: Dot notation is not allowed in field names. Found "user.password" - use a simple field name without dots instead.
```

**When to disable dot notation:**

| Scenario | Recommendation |
|----------|---------------|
| Public search API | Disable - prevents probing internal table structures |
| Admin dashboard | Enable - admins may need cross-table queries |
| Simple flat schema | Disable - simplifies security model |
| JSON/JSONB columns | Enable - needed for nested data access |
| Multi-tenant app | Disable - prevents `tenant.secret` style access |

**Concrete example - Public e-commerce search:**

```typescript
// For a public product search endpoint, disable dot notation
// to prevent users from attempting queries like:
// - "orders.creditCard" (accessing other tables)
// - "internal.costPrice" (accessing internal JSON fields)
// - "admin.notes" (accessing admin-only data)

const publicSearchKit = createQueryKit({
  adapter: drizzleAdapter,
  schema: { products },
  security: {
    allowDotNotation: false,
    allowedFields: ['name', 'description', 'price', 'category'],
    denyValues: {
      category: ['internal', 'discontinued']
    }
  }
});
```

## Input Parsing for Search UIs

QueryKit provides utilities for building rich search bar experiences with real-time feedback, including key:value highlighting, autocomplete suggestions, and error recovery hints.

### Real-Time Token Parsing

Use `parseQueryInput` and `parseQueryTokens` for lightweight, real-time parsing as users type:

```typescript
import { parseQueryInput, parseQueryTokens } from '@gblikas/querykit';

// Parse input to get terms and cursor context
const input = 'status:done AND priority:';
const result = parseQueryInput(input, { cursorPosition: 25 });

// result.terms contains parsed terms:
// [{ key: 'status', value: 'done', ... }, { key: 'priority', value: null, ... }]

// result.cursorContext tells you where the cursor is: 'key', 'value', or 'operator'
console.log(result.cursorContext); // 'value' (cursor is after 'priority:')

// Get interleaved tokens (terms + operators) for highlighting
const tokens = parseQueryTokens(input);
// [
//   { type: 'term', key: 'status', value: 'done', startPosition: 0, endPosition: 11 },
//   { type: 'operator', operator: 'AND', startPosition: 12, endPosition: 15 },
//   { type: 'term', key: 'priority', value: null, startPosition: 16, endPosition: 25 }
// ]
```

### Rich Context with parseWithContext

For comprehensive parsing with schema validation, autocomplete, and error recovery:

```typescript
import { QueryParser } from '@gblikas/querykit';

const parser = new QueryParser();

// Define your schema for validation and autocomplete
const schema = {
  status: {
    type: 'string',
    allowedValues: ['todo', 'doing', 'done'],
    description: 'Task status'
  },
  priority: { type: 'number', description: 'Priority level (1-5)' },
  assignee: { type: 'string', description: 'Assigned user' }
};

const result = parser.parseWithContext('status:do', {
  cursorPosition: 9,
  schema,
  securityOptions: { maxClauseCount: 10 }
});

// Always returns a result object (never throws)
console.log(result.success);    // true/false - whether parsing succeeded
console.log(result.tokens);     // Tokenized input (always available)
console.log(result.structure);  // Query structure analysis
console.log(result.ast);        // AST (if successful)
console.log(result.error);      // Error details (if failed)

// Autocomplete suggestions based on cursor position
console.log(result.suggestions);
// {
//   context: 'value',
//   currentField: 'status',
//   values: [
//     { value: 'doing', score: 80 },
//     { value: 'done', score: 80 }
//   ]
// }

// Schema validation results
console.log(result.fieldValidation);
// { valid: true, fields: [...], unknownFields: [] }

// Security pre-check
console.log(result.security);
// { passed: true, violations: [], warnings: [] }
```

### Error Recovery

When parsing fails, `parseWithContext` provides helpful recovery hints:

```typescript
const result = parser.parseWithContext('status:"incomplete');

console.log(result.recovery);
// {
//   issue: 'unclosed_quote',
//   message: 'Unclosed double quote detected',
//   suggestion: 'Add a closing " to complete the quoted value',
//   autofix: 'status:"incomplete"',
//   position: 7
// }
```

Error types detected:
- `unclosed_quote` - Missing closing quote (with autofix)
- `unclosed_parenthesis` - Unbalanced parentheses (with autofix)
- `trailing_operator` - Query ends with AND/OR/NOT (with autofix)
- `missing_value` - Field has colon but no value
- `syntax_error` - Generic syntax issue

### Building a Search Bar with Highlighting

Here's a React example using the input parser for highlighting:

```tsx
import { parseQueryTokens } from '@gblikas/querykit';

function SearchBar({ value, onChange }) {
  const tokens = parseQueryTokens(value);

  const renderHighlightedQuery = () => {
    if (!value) return null;

    return tokens.map((token, idx) => {
      const text = value.slice(token.startPosition, token.endPosition);

      if (token.type === 'operator') {
        return <span key={idx} className="text-purple-500">{text}</span>;
      }

      // Term token - highlight key and value differently
      if (token.key && token.operator) {
        const keyEnd = token.startPosition + token.key.length;
        const opEnd = keyEnd + token.operator.length;
        return (
          <span key={idx}>
            <span className="text-orange-400">{token.key}</span>
            <span className="text-gray-500">{token.operator}</span>
            <span className="text-blue-400">{value.slice(opEnd, token.endPosition)}</span>
          </span>
        );
      }

      return <span key={idx}>{text}</span>;
    });
  };

  return (
    <div className="relative">
      <div className="absolute inset-0 pointer-events-none">
        {renderHighlightedQuery()}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-transparent caret-black"
      />
    </div>
  );
}
```

## Virtual Fields

Virtual fields enable powerful shortcuts in your queries that expand to real schema fields at query execution time based on runtime context. This allows you to support queries like `my:assigned` which expands to `assignee_id == <current_user_id>` using the currently logged-in user's ID.

### Why Virtual Fields?

Virtual fields are useful when:
- You want to provide user-friendly shortcuts (e.g., `my:assigned` instead of `assignee_id:123`)
- The query depends on runtime context (current user, permissions, tenant, etc.)
- You want to abstract complex field mappings from end users
- You need consistent query shortcuts across your application

### Basic Usage

Define virtual fields when creating your QueryKit instance:

```typescript
import { createQueryKit } from '@gblikas/querykit';
import { drizzleAdapter } from '@gblikas/querykit/adapters/drizzle';

const qk = createQueryKit({
  adapter: drizzleAdapter,
  schema: { tasks, users },

  // Define virtual fields
  virtualFields: {
    my: {
      allowedValues: ['assigned', 'created', 'watching'] as const,
      description: 'Filter by your relationship to items',
      
      resolve: (input, ctx, { fields }) => {
        // Map virtual values to real schema fields
        const fieldMap = fields({
          assigned: 'assignee_id',
          created: 'creator_id',
          watching: 'watcher_ids'
        });

        return {
          type: 'comparison',
          field: fieldMap[input.value],
          operator: '==',
          value: ctx.currentUserId
        };
      }
    }
  },

  // Provide runtime context
  createContext: async () => ({
    currentUserId: await getCurrentUserId(),
    currentUserTeamIds: await getUserTeamIds()
  })
});

// Use virtual fields in queries
const myTasks = await qk
  .query('tasks')
  .where('my:assigned AND status:active')
  .execute();
```

### Configuration Options

Each virtual field definition supports:

```typescript
{
  // Required: allowed values for this virtual field
  allowedValues: ['value1', 'value2'] as const,

  // Optional: allow comparison operators (>, <, >=, <=)
  // Default: false (only equality ":" is allowed)
  allowOperators?: boolean,

  // Required: resolver function
  resolve: (input, context, helpers) => {
    // Return a query expression that replaces the virtual field
    return {
      type: 'comparison',
      field: 'real_field',
      operator: '==',
      value: context.someValue
    };
  },

  // Optional: human-readable description
  description?: string,

  // Optional: descriptions for each value
  valueDescriptions?: {
    value1: 'Description of value1',
    value2: 'Description of value2'
  }
}
```

### Type-Safe Field Mapping

The `fields()` helper provides compile-time validation that all mapped fields exist in your schema:

```typescript
virtualFields: {
  my: {
    allowedValues: ['assigned', 'created'] as const,
    resolve: (input, ctx, { fields }) => {
      // TypeScript validates:
      // 1. All allowedValues keys are mapped
      // 2. All field values exist in the schema
      const fieldMap = fields({
        assigned: 'assignee_id',  // ✓ Valid schema field
        created: 'creator_id'      // ✓ Valid schema field
        // Missing 'created' → TypeScript error!
        // invalid_field → TypeScript error!
      });

      return {
        type: 'comparison',
        field: fieldMap[input.value],
        operator: '==',
        value: ctx.currentUserId
      };
    }
  }
}
```

### Context Factory

The `createContext` function is called once per query execution to provide runtime values:

```typescript
createContext: async () => {
  const user = await getCurrentUser();
  const permissions = await getUserPermissions(user.id);
  
  return {
    currentUserId: user.id,
    currentUserTeamIds: user.teamIds,
    canSeeArchived: permissions.includes('view:archived')
  };
}
```

Context is type-safe and can include any data your resolvers need:

```typescript
interface MyQueryContext extends IQueryContext {
  currentUserId: number;
  currentUserTeamIds: number[];
  canSeeArchived: boolean;
}

const qk = createQueryKit<typeof schema, MyQueryContext>({
  // ... configuration
});
```

### Complex Resolvers

Virtual fields can return logical expressions for more complex scenarios:

```typescript
virtualFields: {
  myItems: {
    allowedValues: ['all'] as const,
    resolve: (input, ctx) => ({
      // Return a logical OR expression
      type: 'logical',
      operator: 'OR',
      left: {
        type: 'comparison',
        field: 'assignee_id',
        operator: '==',
        value: ctx.currentUserId
      },
      right: {
        type: 'comparison',
        field: 'creator_id',
        operator: '==',
        value: ctx.currentUserId
      }
    })
  }
}

// Expands to: (assignee_id == currentUserId OR creator_id == currentUserId)
await qk.query('tasks').where('myItems:all').execute();
```

### Allowing Comparison Operators

By default, only equality (`:`) is allowed. Enable other operators with `allowOperators: true`:

```typescript
virtualFields: {
  priority: {
    allowedValues: ['high', 'low'] as const,
    allowOperators: true,  // Enable >, <, etc.
    
    resolve: (input, ctx) => {
      const threshold = input.value === 'high' ? 7 : 3;
      
      return {
        type: 'comparison',
        field: 'priority',
        operator: input.operator,  // Use the operator from the query
        value: threshold
      };
    }
  }
}

// Both work:
qk.query('tasks').where('priority:high')    // priority == 7
qk.query('tasks').where('priority:>high')  // priority > 7
```

### Error Handling

QueryKit throws `QueryParseError` for invalid virtual field usage:

```typescript
// Invalid value
qk.query('tasks').where('my:invalid')
// Error: Invalid value "invalid" for virtual field "my". 
//        Allowed values: "assigned", "created", "watching"

// Operator not allowed (when allowOperators: false)
qk.query('tasks').where('my:>assigned')
// Error: Virtual field "my" does not allow comparison operators. 
//        Only equality (":") is permitted.
```

### Complete Example

Here's a full example with multiple virtual fields:

```typescript
import { createQueryKit, IQueryContext } from '@gblikas/querykit';
import { drizzleAdapter } from '@gblikas/querykit/adapters/drizzle';

// Define your context type
interface TaskQueryContext extends IQueryContext {
  currentUserId: number;
  currentUserTeamIds: number[];
  currentTenantId: string;
}

// Create QueryKit with virtual fields
const qk = createQueryKit<typeof schema, TaskQueryContext>({
  adapter: drizzleAdapter,
  schema: { tasks, users },

  virtualFields: {
    // User relationship shortcuts
    my: {
      allowedValues: ['assigned', 'created', 'watching'] as const,
      description: 'Filter by your relationship to tasks',
      valueDescriptions: {
        assigned: 'Tasks assigned to you',
        created: 'Tasks you created',
        watching: 'Tasks you are watching'
      },
      resolve: (input, ctx, { fields }) => {
        const fieldMap = fields({
          assigned: 'assignee_id',
          created: 'creator_id',
          watching: 'watcher_ids'
        });
        return {
          type: 'comparison',
          field: fieldMap[input.value],
          operator: '==',
          value: ctx.currentUserId
        };
      }
    },

    // Team shortcuts
    team: {
      allowedValues: ['assigned', 'owned'] as const,
      description: 'Filter by team relationship',
      resolve: (input, ctx, { fields }) => {
        const fieldMap = fields({
          assigned: 'assignee_id',
          owned: 'owner_id'
        });
        return {
          type: 'comparison',
          field: fieldMap[input.value],
          operator: 'IN',
          value: ctx.currentUserTeamIds
        };
      }
    },

    // Priority shortcuts with operators
    priority: {
      allowedValues: ['critical', 'high', 'normal', 'low'] as const,
      allowOperators: true,
      description: 'Filter by priority level',
      resolve: (input) => {
        const priorityMap = {
          critical: 10,
          high: 7,
          normal: 5,
          low: 3
        };
        return {
          type: 'comparison',
          field: 'priority',
          operator: input.operator as any,
          value: priorityMap[input.value as keyof typeof priorityMap]
        };
      }
    }
  },

  // Context factory
  createContext: async () => {
    const user = await getCurrentUser();
    const teams = await getUserTeams(user.id);
    
    return {
      currentUserId: user.id,
      currentUserTeamIds: teams.map(t => t.id),
      currentTenantId: user.tenantId
    };
  }
});

// Example queries using virtual fields
// "my:assigned AND status:active"
// "team:assigned OR my:created"
// "priority:>high AND my:watching"
// "(my:assigned OR team:assigned) AND status:active"

const results = await qk
  .query('tasks')
  .where('my:assigned AND priority:>high')
  .orderBy('created_at', 'desc')
  .limit(10)
  .execute();
```

## Roadmap

### Core Parsing Engine and DSL
- [x] Implement Lucene-style query syntax parser using Liqe
- [x] Create type-safe query building API
- [x] Develop internal AST representation
- [x] Implement consistent syntax for logical operators (AND, OR, NOT)
- [x] Support standard comparison operators (==, !=, >, >=, <, <=)
- [x] Real-time input parsing for search UIs
- [x] Autocomplete suggestions with schema awareness
- [x] Error recovery hints with autofix

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
- [x] Virtual fields for context-aware query expansion

### Ecosystem Expansion
- [x] Frontend query builder components (input parser)
- [ ] Additional ORM adapters
- [ ] Server middleware for Express/Fastify
- [ ] TypeScript SDK generation

## Contributing

See the [CONTRIBUTING.md](CONTRIBUTING.md) file for details on how to get started.

## License

This project is licensed under the GPL License - see the [LICENSE](LICENSE) file for details. 