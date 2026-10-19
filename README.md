# QueryKit

QueryKit compiles a Liqe / GitHub-like filter string into a Drizzle query or an in-memory filter, with field allowlists, clause limits, request-context virtual fields, and a token parser for a search box. Other ORMs, a CLI, and HTTP middleware are not implemented.

## What Does QueryKit Do?

QueryKit takes one filter string and evaluates it with the Drizzle adapter or with `filterInMemory`.

- **Filter and sort with a Liqe query** – For example, `status:done AND priority:>2`.

- **Translate that string to Drizzle, or apply it in memory** – `drizzleAdapter` builds a Drizzle query. `filterInMemory` and `inMemoryAdapter` keep rows that match the same operators.

- **Share the string between a database query and a fetched array** – The Query Syntax section is the contract for both.

## Quick Start

Below are various examples of how to use QueryKit.

**Drizzle ORM**

```typescript

// schema.ts
import { serial, text, pgTable } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('draft')
});

// example.ts
import { users } from './schema';
import { createQueryKit, drizzleAdapter } from '@gblikas/querykit';

// Create a QueryKit instance with the Drizzle adapter; db is your Drizzle database
const qk = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { users } }),
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

**In-memory**

The same query string can filter a fetched array. QueryKit parses it with the existing parser and keeps a row when it satisfies the same operators the Drizzle translator emits. `status:active` keeps `active`. `priority:2` keeps `2`. `*` and `?` are SQL LIKE, including inside quotes. Under a wildcard, ASCII letters match in either case, as in SQLite, so `status:act*` keeps `Active`; `ö` and `Ö` stay distinct, and equality stays case-sensitive. Order, limit, and offset then run as field order on that result.

```typescript
import { createQueryKit, filterInMemory, inMemoryAdapter } from '@gblikas/querykit';

const tasks = [
  { title: 'Ship release', status: 'done', priority: 3 },
  { title: 'Fix bug', status: 'inactive', priority: 1 }
];

filterInMemory('status:done AND priority:>2', tasks);
// => [{ title: 'Ship release', status: 'done', priority: 3 }]

const qk = createQueryKit({
  adapter: inMemoryAdapter({ records: { tasks } }),
  schema: { tasks: { title: {}, status: {}, priority: {} } }
});

const preview = await qk.query('tasks').where('status:done AND priority:>2').execute();
```

When the rows use different keys than the query, give the adapter `fieldMappings`. The schema lists the names a query uses; the adapter renames them to row keys after validation, for comparisons and for `orderBy`.

```typescript
import { createQueryKit, inMemoryAdapter } from '@gblikas/querykit';

const rows = [{ title: 'Ship release', task_status: 'done', priority: 3 }];

const mapped = createQueryKit({
  adapter: inMemoryAdapter({
    records: { tasks: rows },
    fieldMappings: { status: 'task_status' }
  }),
  schema: { tasks: { title: {}, status: {}, priority: {} } }
});

await mapped.query('tasks').where('status:done').orderBy('status').execute();
// => [{ title: 'Ship release', task_status: 'done', priority: 3 }]
```

## Query Syntax

QueryKit parses the string with Liqe. The Drizzle translator and the in-memory adapter then evaluate that AST with the same operators. `status:active` is equality with `active`: it does not match `inactive` or `Active` when the comparison is case-sensitive. `status:"Active"` is the same kind of equality with `Active`. `priority:2` and `priority:=2` are equality with the number `2`, so `12` does not match. `*` and `?` are LIKE, including inside quotes: `*` is any sequence, `?` is one character, and the pattern is anchored to the whole value. Equality is case-sensitive on PostgreSQL and in the in-memory adapter; on SQLite and MySQL it follows the column collation. LIKE is case-sensitive on PostgreSQL and follows the engine on SQLite and MySQL; the in-memory adapter follows SQLite's default LIKE, so ASCII letters match in either case under `*` or `?` while other letters such as `ö` and `Ö` stay distinct. A boolean such as `done:true` compared with a Drizzle schema column is bound through that column's own mapping, as `eq(column, true)` binds it, so a PostgreSQL or MySQL `boolean()` column receives a boolean parameter and a text or integer column fails with the database's own error; a SQLite column without boolean mode, and any field with no schema column, gets the literal written as `TRUE` or `FALSE`, which SQLite reads as 1 or 0, since no SQLite driver binds a boolean. A slash pattern such as `name:/Todo.*/` or `name:/foo/` parses as operator `REGEX`, with or without `*` or `?` inside it, and the Drizzle translator and the in-memory adapter reject that operator with an unsupported-operator error.

A field name matches a Drizzle property or an in-memory key exactly, or else the one name differing only by ASCII case, so a renamed column is reached by its property. A name that matches no property of the selected table is rejected on both adapters before any row is read, with `DrizzleAdapterError` and `InMemoryAdapterError`, rather than quoted as a raw identifier: with the property `status` on the column `status_col`, `status_col:open`, `created_at:null`, the quoted `"Items.status":open` and `orderBy('created_at')` are all rejected. The Drizzle translator without a schema still quotes a name as written, and an in-memory table with no rows has no keys to check. A single `table.column` is matched to the selected table the same way on both adapters: `Items.status` reads the `items` column `status`, while `Other.status`, or `owners.tier` with `owners` another table, is rejected before any row is read; `filterInMemory` has no table and reads the column of any single qualifier. In memory a dotted name reads an own key of the whole name first and never a nested path.

```
# Equality
status:active         # equals active; does not match inactive or Active
status:"Active"       # equals Active

# Comparison operators
priority:2                # equals 2; does not match 12
priority:=2               # same equality as priority:2
priority:>2               # Greater than
priority:>=2              # Greater than or equal
priority:<2               # Less than
priority:<=2              # Less than or equal

# Numeric ranges
priority:[2 TO 3]         # Inclusive range
priority:{2 TO 3}         # Exclusive range

# LIKE
title:intro*          # intro followed by anything
title:Sh?p            # one character between Sh and p
title:"Ship*"         # quotes keep the same LIKE

# Regex parses as operator REGEX and is rejected by translators and in-memory
name:/Todo.*/         # unsupported operator REGEX
name:/foo/            # unsupported operator REGEX

# Boolean operators (case insensitive)
status:active AND priority:>2     # AND operator
status:active OR status:pending   # OR operator
NOT expired:true      # NOT operator
-expired:true         # Alternative NOT syntax
status:active and name:test       # Lowercase operators work too
status:active Or priority:>2      # Mixed case also supported

# Grouping
(status:active OR status:pending) AND priority:<3

# Implicit AND (space between expressions)
status:active priority:>2
```

## Parser Options

`createQueryKit` accepts a `parserOptions` field to configure the underlying `QueryParser`. This avoids the need for manual query string preprocessing.

### Field Mappings

Map user-friendly field names to actual schema column names:

```typescript
import { createQueryKit, drizzleAdapter } from '@gblikas/querykit';

const qk = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { users } }),
  schema: { users },
  parserOptions: {
    fieldMappings: {
      author: 'author_name',
      name: 'title',
      created_by: 'created_by_name',
    }
  }
});

// Users can query with friendly names:
const results = await qk
  .query('users')
  .where('author:"Jane Doe" AND name:safety')
  .execute();
// Internally resolves to: author_name:"Jane Doe" AND title:safety
```

### Case-Insensitive Fields

Enable case-insensitive field name matching:

```typescript
import { createQueryKit, drizzleAdapter } from '@gblikas/querykit';

const qk = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { users } }),
  schema: { users },
  parserOptions: {
    caseInsensitiveFields: true,
    fieldMappings: { status: 'task_status' }
  }
});

// All of these resolve to task_status:active
qk.query('users').where('Status:active');
qk.query('users').where('STATUS:active');
qk.query('users').where('status:active');

// A sort key is folded and mapped the same way, so this orders by
// task_status on Drizzle and in memory alike
qk.query('users').where('status:active').orderBy('STATUS', 'desc');
```

The parser folds a field to lower case, so a camelCase property such as `createdAt` arrives as `createdat`. `createQueryKit` respells that folded name as the one schema property that differs from it only by ASCII case, in the query, in `orderBy`, and in `allowedFields`, `denyFields` and the keys of `denyValues`, before the allowlist compares it, so `CreatedAt:null`, `createdat:null` and `orderBy('createdAt')` all reach `createdAt` on Drizzle and in memory. A name that folds onto two properties differing only by case, such as `createdAt` beside `CreatedAt`, is rejected with `QuerySecurityError: Invalid query parameters` on both adapters, as a filter and as a sort key.

## Tolerant Parse Mode

By default, `createQueryKit` throws on any malformed input. For search UIs where queries may be submitted in a transiently incomplete state, enable tolerant mode to leverage `parseWithContext`'s built-in error recovery:

```typescript
import { createQueryKit, drizzleAdapter } from '@gblikas/querykit';

const qk = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { tasks } }),
  schema: { tasks },
  tolerant: true
});

// These auto-recover instead of throwing:
await qk.query('tasks').where('status:active AND').execute();
// → Autofixes to: 'status:active'

await qk.query('tasks').where('status:"incomplete').execute();
// → Autofixes to: 'status:"incomplete"'
```

Recovery types supported by tolerant mode:
- **Trailing `AND` or `OR`** — `status:active AND` → `status:active`; a trailing `NOT` is not dropped, since that would run the clause it was about to negate
- **Unclosed quotes** — `status:"active` → `status:"active"`
- **Missing closing parentheses** — `(status:active` → `(status:active)`

If autofix also fails, an error is still thrown, ensuring silent data corruption never occurs.

## Installation

```bash
npm install @gblikas/querykit
```

## Dependencies

QueryKit leverages several key dependencies to provide its functionality:

- [**Liqe**](https://github.com/gajus/liqe): A lightweight Lucene-like parser. QueryKit uses Liqe to parse the query string into an AST. The Drizzle translator and the in-memory adapter evaluate that AST.

- [**Drizzle ORM**](https://github.com/drizzle-team/drizzle-orm): A TypeScript ORM for SQL databases. QueryKit peers `drizzle-orm` `>=0.30.2 <0.46.0`. The Drizzle adapter translates queries into Drizzle queries. Install Drizzle in the app; QueryKit does not bundle its own copy.

## Security Features

QueryKit provides configurable security guardrails to protect your database from potentially harmful queries while maintaining flexibility. These features can be configured during initialization:

> **IMPORTANT DISCLAIMER**: While QueryKit provides guardrails to help protect against common query-related vulnerabilities, it is not a comprehensive security solution. These features are provided as helpful tools, not guarantees. You are still responsible for implementing proper authentication, authorization, and other security measures in your application. QueryKit does not guarantee protection against all forms of database attacks or query exploits.

```typescript
import { createQueryKit, drizzleAdapter } from '@gblikas/querykit';

const qk = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { users } }),
  schema: { users },
  security: {
    // Field restrictions
    allowedFields: ['name', 'email', 'priority', 'status'], // Only these fields can be queried
    denyFields: ['password', 'secretKey'],            // These fields can never be queried
    
    // Value restrictions - deny specific values for fields
    denyValues: {
      status: ['deleted', 'banned'],      // Block queries for deleted/banned records
      role: ['superadmin', 'system'],     // Prevent querying privileged roles
      'user.type': ['internal', 'bot']    // A table.column key is matched like a denyFields entry
    },
    
    // Field name restrictions
    allowDotNotation: true,    // Set to false to reject any field name with a dot
    
    // Query complexity limits
    maxQueryDepth: 5,          // Maximum nesting level of expressions
    maxClauseCount: 20,        // Maximum number of comparisons
    
    // Resource protection
    defaultLimit: 100,         // Default result limit if none specified
    maxLimit: 1000,            // Maximum allowed limit for pagination
    
    // Value sanitization
    maxValueLength: 100,       // Maximum string length for query values
    sanitizeWildcards: true,   // Prevent regex DoS with wildcards in LIKE queries
    
    // Performance safeguards
    queryTimeout: 5000,        // Budget in milliseconds for the adapter call
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
  enforceExcludedValues: {},   // Empty means no "AND field NOT IN (values)" is appended
  allowDotNotation: true,      // Allow "table.field" notation
  
  // Query complexity limits
  maxQueryDepth: 10,           // Maximum nesting level of expressions
  maxClauseCount: 50,          // Maximum number of comparisons
  
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

A query field and an `orderBy` key are checked against the table the query selected, the one table either adapter reads a field from, and a rejection is `QuerySecurityError: Invalid query parameters` before either adapter runs: with `schema: { items, owners }` and `qk.query('items')`, `tier:gold`, `owners.tier:gold`, `name:null` and `orderBy('tier')` are rejected. With `allowedFields` empty, a query field the selected table does not declare is rejected the same way, and an `orderBy` key is checked against the schema whether or not `allowedFields` is set: it must name a schema property exactly or as the one property that differs only by ASCII case, bare or as `table.property`, so `orderBy('nope')`, `orderBy('items.nope')` and `orderBy('other.status')` are rejected on Drizzle and in memory alike. A `table.` qualifier that differs from the selected table only by ASCII case resolves to it, so `Items.status:open` and `orderBy('Items.createdAt')` read `items` on both adapters; an `allowedFields` entry spells the qualifier as the table key. A selected table that declares no property, or one the schema does not declare, leaves both checks to the adapter. A non-empty `allowedFields` narrows the schema rather than replacing it: a listed field must name a declared property of the selected table, exactly or as the one name differing only by ASCII case, bare or as `table.property`, or be a dotted path whose first segment is a declared property, so `allowedFields: ['status', 'nope']` still rejects `nope:1` and `nope:null` on both adapters. A listed path into a declared column such as `metadata.tags` is forwarded, but neither built-in adapter evaluates it as a JSON path: both read it as `table.column` and reject it, Drizzle with `no such column` and the in-memory adapter because `metadata` is not the selected table, and it is no `orderBy` key on either.

`allowedFields` and `denyFields` apply to an `orderBy` key as they do to a query field, since ordering by a field would reveal its order. A `denyFields` entry matches regardless of ASCII case and of a single `table.` qualifier on either side, the way both adapters resolve a name to a column: `denyFields: ['secret']` rejects `secret:a`, `SECRET:a`, `items.secret:a`, `Items.secret:a` and `"items.secret":a`, and a list spelled `SECRET` or `items.secret` rejects `secret:a` and `orderBy('secret')` too. A `fieldMappings` alias and its target are one field for every list: with `fieldMappings: { hidden: 'secret' }`, `denyFields: ['hidden']` and `denyFields: ['secret']` both reject `hidden:a`, `secret:a`, `orderBy('hidden')` and `orderBy('secret')`, and `allowedFields: ['status', 'hidden']` and `['status', 'secret']` both permit the four while still rejecting `id:3`. A value listed in `denyValues` under any spelling, alias or alias target of a field is denied for every spelling of that field, so `{ hidden: ['a'] }`, `{ secret: ['a'] }`, `{ SECRET: ['a'] }` and `{ 'items.secret': ['a'] }` each reject `hidden:a`, `secret:a`, `items.secret:a`, `hidden:in [a, b]` and `NOT hidden:a` while `hidden:c` still runs, and an `enforceExcludedValues` key naming the alias is injected under its target, so both adapters drop the same rows.

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

// app.ts
import securityConfig from './security-config.json';
import { createQueryKit, drizzleAdapter } from '@gblikas/querykit';

const qk = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { users } }),
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

QueryKit accepts a dotted field name such as `products.name`, which both adapters read as `table.column` with the table part naming the selected table (see Query Syntax). Neither adapter reads a JSON path or an ORM relation through a dot, and a name with two or more dots is one identifier. You may still want to **disable dot notation** for public-facing APIs:

```typescript
import { createQueryKit, drizzleAdapter } from '@gblikas/querykit';

const qk = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { products } }),
  schema: { products },
  security: {
    allowDotNotation: false,  // Reject queries like "user.password" or "config.secret"
    allowedFields: ['name', 'price', 'category', 'inStock']
  }
});

// ✅ Allowed: Simple field names
await qk.query('products').where('name:"Widget" AND price:<100').execute();

// ❌ Rejected: Dot notation
await qk.query('products').where('user.password:"secret"').execute();
// throws QuerySecurityError: Dot notation is not allowed in field names. Found "user.password" - use a simple field name without dots instead.
```

**When to disable dot notation:**

| Scenario | Recommendation |
|----------|---------------|
| Public search API | Disable - prevents probing internal table structures |
| Admin dashboard | Enable - admins may qualify a column with its table |
| Simple flat schema | Disable - simplifies security model |
| Multi-tenant app | Disable - prevents `tenant.secret` style access |

**Concrete example - Public e-commerce search:**

```typescript
// For a public product search endpoint, disable dot notation so a
// probe such as "orders.creditCard" or "admin.notes" is rejected for
// its dot alone, before the field checks run
import { createQueryKit, drizzleAdapter } from '@gblikas/querykit';

const publicSearchKit = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { products } }),
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

// Parse input to get terms and cursor context; the cursor position is the second argument
const input = 'status:done AND priority:';
const result = parseQueryInput(input, 25);

// The parsed terms
result.terms;
// => [{ key: 'status', value: 'done', ... }, { key: 'priority', value: null, ... }]

// Where the cursor is: 'key', 'operator', 'value', 'between' two terms, or
// 'empty'; here it is after 'priority:'
result.cursorContext;
// => 'value'

// Interleaved tokens (terms + operators) for highlighting
const { tokens } = parseQueryTokens(input);
tokens;
// => [
//   { type: 'term', key: 'status', value: 'done', startPosition: 0, endPosition: 11, ... },
//   { type: 'operator', operator: 'AND', startPosition: 12, endPosition: 15, ... },
//   { type: 'term', key: 'priority', value: null, startPosition: 16, endPosition: 25, ... }
// ]
```

### Rich Context with parseWithContext

For comprehensive parsing with schema validation, autocomplete, and error recovery:

```typescript
import { IFieldSchema, QueryParser } from '@gblikas/querykit';

const parser = new QueryParser();

// Define your schema for validation and autocomplete
const schema: Record<string, IFieldSchema> = {
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

// Always returns a result object (never throws). result.success says
// whether parsing succeeded; result.tokens is always available, and
// result.structure, result.ast (if successful) and result.error (if
// failed) describe the input
result.success;
// => true

// Autocomplete suggestions based on cursor position
result.suggestions;
// => {
//   context: 'value',
//   currentField: 'status',
//   values: [
//     { value: 'doing', score: 80, ... },
//     { value: 'done', score: 80, ... },
//     { value: 'todo', score: 60, ... }
//   ],
//   ...
// }

// Schema validation results
result.fieldValidation;
// => { valid: true, fields: [...], unknownFields: [] }

// Security pre-check
result.security;
// => { passed: true, violations: [], warnings: [] }
```

The `denied_field` and `field_not_allowed` pre-checks match a referenced field the way `createQueryKit` matches its lists for a parser with the same options, and each violation names the field as the parser resolved it. With `securityOptions: { denyFields: ['secret'] }`, `secret:a`, `SECRET:a`, `items.secret:a`, `Items.secret:a` and `"items.secret":a` are reported `denied_field`, as is `hidden:a` under `fieldMappings: { hidden: 'secret' }`, and a list spelled `SECRET`, `items.secret` or `hidden` reports `secret:a` the same way, while `status:open` is reported clean. The allowlist is closed under `fieldMappings` too, so with `allowedFields: ['status', 'hidden']` and the alias above, `hidden:a` and `secret:a` are reported clean as the kit runs them, while `items.status:open` and `id:3` are reported `field_not_allowed` as the kit rejects them; under `caseInsensitiveFields` the entry and the field are compared with `A-Z` folded, so `STATUS:open` is clean there and `field_not_allowed` as written. Both checks also run on the tokenizer's fields when the input does not parse, so `items.secret:` is reported while the user is still typing, where the kit cannot be asked. The pre-check has no table schema, so a listed field the kit rejects as one the table does not declare is still reported clean.

### Error Recovery

When parsing fails, `parseWithContext` provides helpful recovery hints:

```typescript
import { QueryParser } from '@gblikas/querykit';

const parser = new QueryParser();
const result = parser.parseWithContext('status:"incomplete');

result.recovery;
// => {
//   issue: 'unclosed_quote',
//   message: 'Unclosed double quote detected',
//   suggestion: 'Add a closing " to complete the quoted value',
//   autofix: 'status:"incomplete"',
//   position: 7
// }
```

Error types detected:
- `unclosed_quote` - Missing closing quote (with autofix)
- `unclosed_parenthesis` - Unbalanced parentheses (autofix adds missing closers; an extra closer has none)
- `trailing_operator` - Query ends with AND/OR/NOT (autofix drops a trailing AND or OR; a trailing NOT has none)
- `missing_value` - Field has colon but no value
- `syntax_error` - Generic syntax issue

### Building a Search Bar with Highlighting

Here's a React example using the input parser for highlighting:

```tsx
import { parseQueryTokens } from '@gblikas/querykit';

function SearchBar({ value, onChange }) {
  const { tokens } = parseQueryTokens(value);

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
import { createQueryKit, drizzleAdapter } from '@gblikas/querykit';

const qk = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { tasks, users } }),
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
          field: fieldMap[input.value as keyof typeof fieldMap],
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
// fragment: the options of one virtualFields entry
{
  // Required: allowed values for this virtual field
  // Supports string, number, and boolean values
  allowedValues: ['value1', 'value2'] as const,  // strings
  // or
  allowedValues: [1, 2, 3] as const,  // numbers
  // or
  allowedValues: [true, false] as const,  // booleans
  // or
  allowedValues: ['today', 7, true] as const,  // mixed types

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
// fragment: a virtualFields option
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
        // Missing 'watching' → TypeScript error!
        // assigned: 'invalid_field' → TypeScript error!
      });

      return {
        type: 'comparison',
        field: fieldMap[input.value as keyof typeof fieldMap],
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
// fragment: a createContext option
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
// fragment: the context type parameter of createQueryKit
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
// fragment: a virtualFields option, then a query on the kit it configures
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
// fragment: a virtualFields option, then queries on the kit it configures
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
// fragment: qk is the kit from Basic Usage

// Invalid value
await qk.query('tasks').where('my:invalid').execute();
// throws QueryParseError: Invalid value "invalid" for virtual field "my".
//        Allowed values: "assigned", "created", "watching"

// Operator not allowed (when allowOperators: false)
await qk.query('tasks').where('my:>assigned').execute();
// throws QueryParseError: Virtual field "my" does not allow comparison operators.
//        Only equality (":") is permitted.

// Sorted on: a virtual field resolves to a filter, not a column, so no
// engine can order by it. A fieldMappings alias or a spelling folded under
// caseInsensitiveFields that resolves to the virtual field is rejected too.
await qk.query('tasks').where('status:open').orderBy('my').execute();
// throws QueryParseError: Virtual field "my" cannot be used in orderBy.
//        It resolves to a filter, not a column.
```

### Complete Example

Here's a full example with multiple virtual fields:

```typescript
import { createQueryKit, drizzleAdapter, IQueryContext, ComparisonOperator } from '@gblikas/querykit';

// Define your context type
interface TaskQueryContext extends IQueryContext {
  currentUserId: number;
  currentUserTeamIds: number[];
  currentTenantId: string;
}

// Create QueryKit with virtual fields
const schema = { tasks, users };
const qk = createQueryKit<typeof schema, TaskQueryContext>({
  adapter: drizzleAdapter({ db, schema }),
  schema,

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
          field: fieldMap[input.value as keyof typeof fieldMap],
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
          field: fieldMap[input.value as keyof typeof fieldMap],
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
          operator: input.operator as ComparisonOperator,
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

#### Non-String Allowed Values

Virtual fields support not just string values, but also numeric and boolean values. This is useful when you want to map query values to numeric priorities, boolean flags, or other non-string types:

```typescript
import { createQueryKit, dateWithinDays, drizzleAdapter } from '@gblikas/querykit';

const qk = createQueryKit({
  schema: mySchema,
  adapter: drizzleAdapter({ db, schema: mySchema }),
  
  virtualFields: {
    // Numeric values for priority filtering
    priorityLevel: {
      allowedValues: [1, 2, 3] as const,
      description: 'Filter by numeric priority level',
      resolve: (input) => ({
        type: 'comparison',
        field: 'priority',
        operator: '==',
        value: input.value  // input.value is typed as 1 | 2 | 3
      })
    },
    
    // Boolean values for status flags
    isActive: {
      allowedValues: [true, false] as const,
      description: 'Filter by active status',
      resolve: (input) => ({
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: input.value ? 'active' : 'inactive'
      })
    },
    
    // Mixed types in the same field
    timeFilter: {
      allowedValues: ['today', 7, 30, true] as const,
      description: 'Flexible time-based filter',
      resolve: (input) => {
        if (input.value === 'today') {
          return dateWithinDays('created_at', 1);
        } else if (typeof input.value === 'number') {
          return dateWithinDays('created_at', input.value);
        } else {
          // true = show all items
          return { type: 'comparison', field: 'id', operator: '>', value: 0 };
        }
      }
    }
  },
  
  createContext: async () => ({})
});

// Example queries:
// "priorityLevel:2"              - Finds items with priority = 2
// "isActive:true"                - Finds active items
// "timeFilter:7"                 - Finds items created in last 7 days
// "timeFilter:today"             - Finds items created today
```

### Raw SQL Expressions

For advanced query patterns that can't be expressed as simple field comparisons, virtual fields can return **raw SQL expressions**. This enables database-specific operations like JSONB array membership checks, date calculations, and custom SQL logic.

#### Why Raw SQL Expressions?

Use raw SQL expressions when you need to:
- **Check JSONB array membership** - e.g., `my:assigned` where `assignedTo` is a JSONB array
- **Implement computed/derived fields** - e.g., `priority:high` based on date calculations
- **Use database-specific functions** - e.g., PostGIS functions, full-text search
- **Combine multiple conditions** - e.g., custom business logic that requires complex SQL

#### Basic Example

```typescript
import { createQueryKit, dateWithinDays, drizzleAdapter, IQueryContext, jsonbContains } from '@gblikas/querykit';
import { sql } from 'drizzle-orm';

interface MyContext extends IQueryContext {
  currentUserId: string;
}

const qk = createQueryKit<typeof schema, MyContext>({
  adapter: drizzleAdapter({ db, schema }),
  schema,

  virtualFields: {
    // JSONB array contains example
    my: {
      allowedValues: ['assigned'] as const,
      description: 'Filter by your relationship to items',
      resolve: (input, ctx) => {
        if (input.value === 'assigned') {
          return jsonbContains('assigned_to', ctx.currentUserId);
        }
        throw new Error(`Unknown value: ${input.value}`);
      }
    },

    // Computed priority based on createdAt
    priority: {
      allowedValues: ['high', 'medium', 'low'] as const,
      description: 'Filter by computed priority (based on age)',
      resolve: (input) => {
        const thresholds = { high: 1, medium: 7, low: 30 };
        const days = thresholds[input.value as keyof typeof thresholds];
        return dateWithinDays('created_at', days);
      }
    },

    // Custom raw SQL example
    custom: {
      allowedValues: ['active'] as const,
      resolve: (input, ctx) => ({
        type: 'raw',
        toSql: () => sql`status = 'active' AND ${sql.identifier('owner_id')} = ${ctx.currentUserId}`
      })
    }
  },

  createContext: async () => ({
    currentUserId: await getCurrentUserId()
  })
});

// Queries that now work:
await qk.query('my_table').where('my:assigned').execute();
await qk.query('my_table').where('priority:high AND status:active').execute();
```

#### Helper Functions

QueryKit provides helper functions for common raw SQL patterns:

##### `jsonbContains(field, value)` - JSONB Array Membership (PostgreSQL)

Checks if a JSONB array field contains the given value:

```typescript
import { jsonbContains } from '@gblikas/querykit';

// Check if assignedTo contains the current user ID
jsonbContains('assigned_to', ctx.currentUserId);
// SQL: "assigned_to" @> '["user123"]'::jsonb

// Works with arrays too
jsonbContains('tags', ['urgent', 'review']);
// SQL: "tags" @> '["urgent","review"]'::jsonb
```

##### `dateWithinDays(field, days)` - Date Range Check

Checks if a timestamp field is within the specified number of days from now:

```typescript
import { dateWithinDays } from '@gblikas/querykit';

// Check if created within last day
dateWithinDays('created_at', 1);
// SQL: "created_at" >= NOW() - INTERVAL '1 days'

// Check if created within last week
dateWithinDays('created_at', 7);
// SQL: "created_at" >= NOW() - INTERVAL '7 days'
```

#### Custom Raw SQL

For complete control, create your own raw SQL expressions:

```typescript
// fragment: a virtualFields option
virtualFields: {
  custom: {
    allowedValues: ['special'] as const,
    resolve: (input, ctx) => ({
      type: 'raw',
      toSql: (context) => {
        // context provides: adapter, tableName, schema
        // Return a Drizzle SQL template
        return sql`
          ${sql.identifier('status')} = 'active' 
          AND ${sql.identifier('owner_id')} = ${ctx.currentUserId}
          AND ${sql.identifier('created_at')} >= NOW() - INTERVAL '30 days'
        `;
      }
    })
  }
}
```

#### Schema Example with JSONB

Here's a complete example with a Drizzle schema that uses JSONB:

```typescript
import { pgTable, serial, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createQueryKit, drizzleAdapter, jsonbContains } from '@gblikas/querykit';

export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 256 }),
  description: varchar('description', { length: 1024 }),
  createdAt: timestamp('created_at').defaultNow(),
  status: varchar('status', { length: 50 }).default('open'),
  // JSONB array of user IDs
  assignedTo: jsonb('assigned_to')
    .$type<string[]>()
    .default(sql`'[]'`)
});

// QueryKit configuration
const qk = createQueryKit({
  adapter: drizzleAdapter({ db, schema: { tasks } }),
  schema: { tasks },
  
  virtualFields: {
    my: {
      allowedValues: ['assigned'] as const,
      resolve: (input, ctx) => jsonbContains('assigned_to', ctx.currentUserId)
    }
  },
  
  createContext: async () => ({
    currentUserId: await getCurrentUserId()
  })
});

// Query: find my assigned tasks that are high priority
await qk.query('tasks')
  .where('my:assigned AND priority:high')
  .execute();
```

#### Combining with Standard Fields

Raw SQL expressions work seamlessly with standard field queries:

```typescript
// fragment: qk is the kit from the JSONB example

// Mix virtual fields (raw SQL) with standard field queries
await qk.query('tasks')
  .where('my:assigned AND status:active AND priority:>5')
  .execute();
  
// Complex nested queries
await qk.query('tasks')
  .where('(my:assigned OR priority:high) AND NOT status:closed')
  .execute();
```

## Roadmap

### Core Parsing Engine and DSL
- [x] Implement Lucene-style query syntax parser using Liqe
- [x] Create type-safe query building API
- [x] Develop internal AST representation
- [x] Implement consistent syntax for logical operators (AND, OR, NOT) with case-insensitive support
- [x] Support standard comparison operators (==, !=, >, >=, <, <=)
- [x] Real-time input parsing for search UIs
- [x] Autocomplete suggestions with schema awareness
- [x] Error recovery hints with autofix

### First Adapters
- [x] Drizzle ORM integration
- [x] Implement SQL translation layer
- [x] In-memory JavaScript filtering
- [x] Query validation and error handling
- [x] Support for schema-aware queries

### Advanced Features
- [x] Performance optimizations for SQL generation
- [x] Support for complex nested expressions
- [x] Raw SQL expressions for virtual fields (JSONB, computed fields, custom SQL)
- [x] Virtual fields for context-aware query expansion

## Contributing

See the [CONTRIBUTING.md](CONTRIBUTING.md) file for details on how to get started.

## License

This project is licensed under the GPL License - see the [LICENSE](LICENSE) file for details. 