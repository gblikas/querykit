import { parse as liqeParse } from 'liqe';
import type {
  BooleanOperatorToken,
  ExpressionToken,
  FieldToken,
  ImplicitBooleanOperatorToken,
  LiqeQuery,
  LogicalExpressionToken,
  ParenthesizedExpressionToken,
  TagToken,
  UnaryOperatorToken
} from 'liqe';
import {
  ComparisonOperator,
  IComparisonExpression,
  ILogicalExpression,
  IParserOptions,
  IQueryParser,
  QueryExpression,
  QueryValue
} from './types';

/**
 * Error thrown when query parsing fails
 */
export class QueryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryParseError';
  }
}

/**
 * Implementation of the QueryKit parser using Liqe
 */
export class QueryParser implements IQueryParser {
  private options: Required<IParserOptions>;

  constructor(options: IParserOptions = {}) {
    this.options = {
      caseInsensitiveFields: options.caseInsensitiveFields ?? false,
      fieldMappings: options.fieldMappings ?? {}
    };
  }

  /**
   * Parse a query string into a QueryKit AST
   */
  public parse(query: string): QueryExpression {
    try {
      const liqeAst = liqeParse(query);
      return this.convertLiqeAst(liqeAst);
    } catch (error) {
      throw new QueryParseError(
        `Failed to parse query: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Validate a query string
   */
  public validate(query: string): boolean {
    try {
      const ast = liqeParse(query);
      this.convertLiqeAst(ast);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convert a Liqe AST node to a QueryKit expression
   */
  private convertLiqeAst(node: LiqeQuery): QueryExpression {
    if (!node || typeof node !== 'object') {
      throw new QueryParseError('Invalid AST node');
    }

    switch (node.type) {
      case 'LogicalExpression': {
        const logicalNode = node as LogicalExpressionToken;
        const operator = (logicalNode.operator as BooleanOperatorToken | ImplicitBooleanOperatorToken).operator;
        return this.createLogicalExpression(
          this.convertLogicalOperator(operator),
          logicalNode.left,
          logicalNode.right
        );
      }

      case 'UnaryOperator': {
        const unaryNode = node as UnaryOperatorToken;
        return this.createLogicalExpression('NOT', unaryNode.operand);
      }

      case 'Tag': {
        const tagNode = node as TagToken;
        const field = tagNode.field as FieldToken;
        const expression = tagNode.expression as ExpressionToken & { value: QueryValue };
        
        if (!field || !expression) {
          throw new QueryParseError('Invalid field or expression in Tag node');
        }

        const fieldName = this.normalizeFieldName(field.name);
        const operator = this.convertLiqeOperator(tagNode.operator.operator);
        const value = this.convertLiqeValue(expression.value);

        // Check for wildcard patterns in string values
        if (operator === '==' && typeof value === 'string' && (value.includes('*') || value.includes('?'))) {
          return this.createComparisonExpression(
            fieldName,
            'LIKE',
            value
          );
        }

        return this.createComparisonExpression(
          fieldName,
          operator,
          value
        );
      }

      case 'EmptyExpression':
        if ('left' in node && node.left) {
          return this.convertLiqeAst(node.left);
        }
        throw new QueryParseError('Invalid empty expression');

      case 'ParenthesizedExpression': {
        const parenNode = node as ParenthesizedExpressionToken;
        if (parenNode.expression) {
          return this.convertLiqeAst(parenNode.expression);
        }
        throw new QueryParseError('Invalid parenthesized expression');
      }

      default:
        throw new QueryParseError(`Unsupported node type: ${(node as { type: string }).type}`);
    }
  }

  /**
   * Convert a Liqe logical operator to a QueryKit operator
   */
  private convertLogicalOperator(operator: string): 'AND' | 'OR' | 'NOT' {
    switch (operator.toLowerCase()) {
      case 'and':
        return 'AND';
      case 'or':
        return 'OR';
      case 'not':
        return 'NOT';
      default:
        throw new QueryParseError(`Unsupported logical operator: ${operator}`);
    }
  }

  /**
   * Create a logical expression from Liqe nodes
   */
  private createLogicalExpression(
    operator: 'AND' | 'OR' | 'NOT',
    left: LiqeQuery,
    right?: LiqeQuery
  ): ILogicalExpression {
    return {
      type: 'logical',
      operator,
      left: this.convertLiqeAst(left),
      ...(right && { right: this.convertLiqeAst(right) })
    };
  }

  /**
   * Create a comparison expression
   */
  private createComparisonExpression(
    field: string,
    operator: ComparisonOperator,
    value: QueryValue
  ): IComparisonExpression {
    return {
      type: 'comparison',
      field,
      operator,
      value
    };
  }

  /**
   * Convert a Liqe operator to a QueryKit operator
   */
  private convertLiqeOperator(operator: string): ComparisonOperator {
    // Handle the case where operator is part of the value for comparison operators
    if (operator === ':') {
      return '==';
    }

    // Check if the operator is prefixed with a colon
    const actualOperator = operator.startsWith(':') ? operator.substring(1) : operator;

    // Map Liqe operators to QueryKit operators
    const operatorMap: Record<string, ComparisonOperator> = {
      '=': '==',
      '!=': '!=',
      '>': '>',
      '>=': '>=',
      '<': '<',
      '<=': '<=',
      'in': 'IN',
      'not in': 'NOT IN'
    };

    const queryKitOperator = operatorMap[actualOperator.toLowerCase()];
    if (!queryKitOperator) {
      throw new QueryParseError(`Unsupported operator: ${operator}`);
    }

    return queryKitOperator;
  }

  /**
   * Convert a Liqe value to a QueryKit value
   */
  private convertLiqeValue(value: unknown): QueryValue {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null ||
      Array.isArray(value)
    ) {
      return value as QueryValue;
    }

    throw new QueryParseError(`Unsupported value type: ${typeof value}`);
  }

  /**
   * Normalize a field name based on parser options
   */
  private normalizeFieldName(field: string): string {
    const normalizedField = this.options.caseInsensitiveFields
      ? field.toLowerCase()
      : field;

    return this.options.fieldMappings[normalizedField] ?? normalizedField;
  }
} 