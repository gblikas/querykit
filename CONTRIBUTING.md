# Contributing to QueryKit

Thank you for your interest in contributing to QueryKit! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) to maintain a respectful and inclusive environment for everyone.

## Getting Started

1. **Fork the repository** and clone it locally
2. **Install dependencies** with `npm install`
3. **Create a branch** for your contribution
4. **Make your changes**
5. **Run tests** to ensure everything works
6. **Submit a pull request**

## Project Structure

QueryKit is organized into several key components:

- **Parser** (`src/parser`): Core query parsing engine that converts DSL expressions into structured internal format (AST)
  - Lexical analyzer
  - Syntax parser
  - AST type definitions
  - Validation logic
  - Integrates with [Liqe](https://github.com/gajus/liqe) for Lucene-like query parsing

- **Translators** (`src/translators`): Convert parsed queries into target-specific formats
  - SQL translator (for Drizzle)
  - JavaScript translator (for in-memory filtering)
  - Each translator implements the standard translator interface

- **Adapters** (`src/adapters`): Connect QueryKit to external systems
  - Drizzle ORM adapter
  - In-memory filtering adapter
  - Each adapter implements the standard adapter interface

- **CLI** (`src/cli`): Command-line interface for testing and debugging
  - Query parsing/testing tools
  - Query translation debugging
  - Code generation utilities

- **Frontend Utilities** (`src/frontend`): Browser-specific implementations
  - Query builder components
  - Client-side filtering utilities
  - Browser-optimized parsing

- **Server Helpers** (`src/server`): Server-side integration utilities
  - Middleware for Express/Fastify
  - Request parsing helpers
  - Database integration utilities

- **Common** (`src/common`): Shared utilities and types

## Key Dependencies

When contributing to QueryKit, you should be familiar with these key dependencies:

- **[Liqe](https://github.com/gajus/liqe)**: A Lucene-like parser that we use for parsing the query syntax. Rather than implementing our own parser from scratch, we'll leverage Liqe's capabilities to parse queries into an abstract syntax tree (AST) that our translators can then work with.

- **[Drizzle ORM](https://github.com/drizzle-team/drizzle-orm)**: The TypeScript ORM we integrate with for SQL database operations. Contributions to the Drizzle adapter should be familiar with how Drizzle ORM works.

## Development Workflow

1. **Choose an issue** from the issue tracker or propose a new feature
2. **Discuss** major changes in issues before implementation
3. **Follow coding standards** as outlined below
4. **Write tests** for your changes
5. **Update documentation** if necessary
6. **Submit a PR** with a clear description of changes

## Coding Standards

### TypeScript Guidelines

1. Use English for all code and documentation
2. Always declare explicit types
3. Document public APIs with JSDoc
4. One export per file when possible
5. Follow SOLID principles

### Naming Conventions

- `PascalCase` for classes, interfaces, type aliases, and enums
- `camelCase` for variables, functions, methods, and properties
- `kebab-case` for file names and directory names
- `UPPERCASE` for constants and environment variables
- `I` prefix for interfaces (e.g., `ITranslator`)

### Function Guidelines

1. Keep functions short (< 20 instructions)
2. Follow single responsibility principle
3. Use early returns to avoid nesting
4. Prefer higher-order functions
5. Use default parameters instead of null checks

## Testing

### Test Organization

1. Co-locate tests with source files
2. Use descriptive test file names: `[feature].test.ts` or `[feature].spec.ts`
3. Group related tests in describe blocks
4. Use clear test case descriptions

### Test Coverage Requirements

- Public APIs: 100% coverage
- Internal implementation: 80% coverage
- Test both success and failure cases
- Include edge cases

## Pull Request Process

1. Ensure all tests pass
2. Update documentation if needed
3. Link related issues
4. Wait for code review
5. Address feedback and requested changes
6. Once approved, a maintainer will merge your PR

## Query Language Design

When working on query language features, follow these principles:

1. Syntax should be readable and intuitive (OData/Lucene-inspired)
2. Support basic comparison operators: `==`, `!=`, `>`, `>=`, `<`, `<=`
3. Support logical operators: `&&`, `||`, `!`
4. Support complex operations: string matching, array operations, nested property access
5. Ensure consistent behavior across environments
6. Prioritize type safety
7. Design for extensibility

## Using Liqe for Query Parsing

For the query parsing capabilities of QueryKit, we're using [Liqe](https://github.com/gajus/liqe) as our foundation. When working with this aspect of the codebase:

1. Learn the Liqe API and AST structure before making changes
2. When extending the parser, ensure compatibility with Liqe's existing functionality
3. Write comprehensive tests for any modifications to the parsing logic
4. Consider the performance implications of your changes, as parsing is a critical path
5. Document any extensions or modifications to the standard Liqe syntax

Example of using Liqe in QueryKit:

```typescript
import { parse, filter } from 'liqe';

// Parse a query string into an AST
const ast = parse('title:"Meeting notes" AND priority:>2');

// Use the AST with our translator or directly with Liqe's filter
const results = filter(ast, dataCollection);
```

## Roadmap and Future Goals

We're currently focusing on:

### Core Parsing Engine and DSL
- [ ] Implementing Lucene-style query syntax parser using Liqe
- [ ] Creating an internal AST representation
- [ ] Developing a type-safe query building API
- [ ] Adding comprehensive validation

### First Adapters
- [ ] Drizzle ORM integration
- [ ] In-memory JavaScript filtering
- [ ] Error handling and validation

### Advanced Features
- [ ] CLI tools for testing and debugging queries
- [ ] Performance optimizations for large queries
- [ ] Support for complex operators and functions
- [ ] Query composition utilities

### Ecosystem Expansion
- [ ] Frontend query builder components
- [ ] Additional ORM adapters
- [ ] Server middleware for Express/Fastify
- [ ] Documentation and examples

## License

By contributing to QueryKit, you agree that your contributions will be licensed under the same [MIT License](LICENSE) that covers the project. 