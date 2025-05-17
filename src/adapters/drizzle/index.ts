/**
 * Drizzle ORM Adapter for QueryKit
 * 
 * This adapter connects QueryKit to Drizzle ORM for database queries.
 */

import { DrizzleTranslator } from '../../translators/drizzle';
import { IAdapter, IAdapterOptions, IQueryExecutionOptions } from '../types';
import { QueryExpression } from '../../parser/types';
import { SQL, SQLWrapper, asc, desc, sql } from 'drizzle-orm';

/**
 * Type for Drizzle ORM database instance
 */
export interface IDrizzleDatabase {
  select: () => { from: (table: unknown) => IDrizzleQueryBuilder };
}

/**
 * Type for Drizzle query builder
 */
export interface IDrizzleQueryBuilder {
  where: (condition: SQL) => IDrizzleQueryBuilder;
  orderBy: (...clauses: SQL[]) => IDrizzleQueryBuilder;
  limit: (limit: number) => IDrizzleQueryBuilder;
  offset: (offset: number) => IDrizzleQueryBuilder;
  // This is already a Promise due to Drizzle's thenable implementation
  [Symbol.toStringTag]: string;
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
}

/**
 * Options specific to the Drizzle adapter
 */
export interface IDrizzleAdapterOptions extends IAdapterOptions {
  /**
   * The Drizzle ORM database instance
   */
  db: IDrizzleDatabase;
  
  /**
   * Schema information with Drizzle table definitions
   */
  schema: Record<string, Record<string, SQLWrapper>>;
  
  /**
   * Whether to normalize field names (e.g., lowercase them)
   */
  normalizeFieldNames?: boolean;
}

/**
 * Options for Drizzle query execution
 */
export interface IDrizzleQueryExecutionOptions extends IQueryExecutionOptions {
  /**
   * Sort fields in the format: { field: 'asc' | 'desc' }
   */
  orderBy?: Record<string, 'asc' | 'desc'>;
  
  /**
   * Maximum number of records to return
   */
  limit?: number;
  
  /**
   * Number of records to skip
   */
  offset?: number;
}

/**
 * Error thrown when adapter operations fail
 */
export class DrizzleAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrizzleAdapterError';
  }
}

/**
 * Adapter for Drizzle ORM
 */
export class DrizzleAdapter implements IAdapter<IDrizzleAdapterOptions> {
  private db!: IDrizzleDatabase;
  private schema!: Record<string, Record<string, SQLWrapper>>;
  private translator!: DrizzleTranslator;
  private initialized: boolean = false;

  /**
   * Initialize the adapter with options
   */
  public initialize(options: IDrizzleAdapterOptions): void {
    if (!options.db) {
      throw new DrizzleAdapterError('Drizzle db instance is required');
    }
    
    if (!options.schema) {
      throw new DrizzleAdapterError('Schema definition is required');
    }
    
    this.db = options.db;
    this.schema = options.schema;
    this.translator = new DrizzleTranslator({
      normalizeFieldNames: options.normalizeFieldNames,
      fieldMappings: options.fieldMappings,
      schema: options.schema
    });
    
    this.initialized = true;
  }

  /**
   * Execute a QueryKit expression using Drizzle ORM
   */
  public async execute<TResult = unknown>(
    tableName: string, 
    expression: QueryExpression,
    options?: IDrizzleQueryExecutionOptions
  ): Promise<TResult[]> {
    this.ensureInitialized();
    
    const table = this.getTable(tableName);
    
    if (!table) {
      throw new DrizzleAdapterError(`Table ${tableName} not found in schema`);
    }
    
    try {
      // Start with a base query
      let query = this.db.select().from(table);
      
      // Add where condition if expression is provided
      if (expression) {
        const condition = this.translator.translate(expression);
        query = query.where(condition);
      }
      
      // Add ordering if specified
      if (options?.orderBy) {
        const orderClauses: SQL[] = [];
        
        Object.entries(options.orderBy).forEach(([field, direction]) => {
          // Try to find the field in the schema
          const schemaField = this.getSchemaField(tableName, field);
          
          if (schemaField) {
            // If field exists in schema, use it directly
            orderClauses.push(direction === 'asc' ? asc(schemaField) : desc(schemaField));
          } else {
            // Otherwise use raw SQL
            orderClauses.push(sql`${sql.identifier(field)} ${sql.raw(direction.toUpperCase())}`);
          }
        });
        
        if (orderClauses.length > 0) {
          query = query.orderBy(...orderClauses);
        }
      }
      
      // Add limit if specified
      if (options?.limit !== undefined) {
        query = query.limit(options.limit);
      }
      
      // Add offset if specified
      if (options?.offset !== undefined) {
        query = query.offset(options.offset);
      }
      
      // Execute the query
      const result = await query;
      return result as TResult[];
    } catch (error) {
      throw new DrizzleAdapterError(
        `Failed to execute query: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check if an expression can be executed by this adapter
   */
  public canExecute(expression: QueryExpression): boolean {
    try {
      this.ensureInitialized();
      return this.translator.canTranslate(expression);
    } catch {
      return false;
    }
  }

  /**
   * Get a table from the schema
   */
  private getTable(tableName: string): unknown {
    return this.schema[tableName];
  }

  /**
   * Get a field from the schema
   */
  private getSchemaField(tableName: string, fieldName: string): SQLWrapper | null {
    const table = this.schema[tableName];
    if (table && fieldName in table) {
      return table[fieldName];
    }
    return null;
  }

  /**
   * Ensure the adapter is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new DrizzleAdapterError('Adapter has not been initialized');
    }
  }
} 