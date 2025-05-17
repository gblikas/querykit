import { QueryBuilder } from './builder';
import { ComparisonOperator } from './types';

interface ITodo {
  id: number;
  title: string;
  priority: number;
  status: string;
  dueDate: string;
}

describe('QueryBuilder', () => {
  let builder: QueryBuilder<ITodo>;

  beforeEach(() => {
    builder = new QueryBuilder<ITodo>();
  });

  describe('where', () => {
    it('should create a simple comparison query', () => {
      const query = builder.where('priority', '>', 2).toString();

      expect(query).toBe('priority:>2');
    });

    it('should handle string values', () => {
      const query = builder.where('status', '==', 'active').toString();

      expect(query).toBe('status:"active"');
    });

    it('should handle null values', () => {
      const query = builder.where('dueDate', '==', null).toString();

      expect(query).toBe('dueDate:null');
    });

    it('should handle array values', () => {
      const query = builder
        .where('status', 'IN', ['active', 'pending'])
        .toString();

      expect(query).toBe('status:in["active","pending"]');
    });

    it('should accept direct query string syntax', () => {
      const query = builder.where('priority:>2').toString();

      expect(query).toBe('priority:>2');
    });

    it('should combine direct query strings with AND', () => {
      const query = builder
        .where('priority:>2')
        .andWhere('status:"active"')
        .toString();

      expect(query).toBe('(priority:>2) AND status:"active"');
    });
  });

  describe('andWhere', () => {
    it('should combine conditions with AND', () => {
      const query = builder
        .where('priority', '>', 2)
        .andWhere('status', '==', 'active')
        .toString();

      expect(query).toBe('(priority:>2) AND status:"active"');
    });

    it('should handle multiple AND conditions', () => {
      const query = builder
        .where('priority', '>', 2)
        .andWhere('status', '==', 'active')
        .andWhere('dueDate', '!=', null)
        .toString();

      expect(query).toBe(
        '((priority:>2) AND status:"active") AND dueDate:!=null'
      );
    });

    it('should handle andWhere as first condition with field-operator-value', () => {
      const query = builder.andWhere('priority', '>', 2).toString();

      expect(query).toBe('priority:>2');
    });

    it('should handle andWhere as first condition with query string', () => {
      const query = builder.andWhere('priority:>2').toString();

      expect(query).toBe('priority:>2');
    });
  });

  describe('orWhere', () => {
    it('should combine conditions with OR', () => {
      const query = builder
        .where('status', '==', 'active')
        .orWhere('status', '==', 'pending')
        .toString();

      expect(query).toBe('(status:"active") OR status:"pending"');
    });

    it('should handle multiple OR conditions', () => {
      const query = builder
        .where('status', '==', 'active')
        .orWhere('status', '==', 'pending')
        .orWhere('status', '==', 'inactive')
        .toString();

      expect(query).toBe(
        '((status:"active") OR status:"pending") OR status:"inactive"'
      );
    });

    it('should handle orWhere as first condition with field-operator-value', () => {
      const query = builder.orWhere('priority', '>', 2).toString();

      expect(query).toBe('priority:>2');
    });

    it('should handle orWhere as first condition with query string', () => {
      const query = builder.orWhere('priority:>2').toString();

      expect(query).toBe('priority:>2');
    });
  });

  describe('notWhere', () => {
    it('should create a NOT condition', () => {
      const query = builder.notWhere('status', '==', 'inactive').toString();

      expect(query).toBe('NOT status:"inactive"');
    });

    it('should combine NOT with other conditions', () => {
      const query = builder
        .where('priority', '>', 2)
        .notWhere('status', '==', 'inactive')
        .toString();

      expect(query).toBe('(priority:>2) AND NOT status:"inactive"');
    });

    it('should handle notWhere as first condition with query string', () => {
      const query = builder.notWhere('status:"inactive"').toString();

      expect(query).toBe('NOT status:"inactive"');
    });

    it('should handle notWhere with query string and existing expression', () => {
      const query = builder
        .where('priority', '>', 2)
        .notWhere('status:"inactive"')
        .toString();

      expect(query).toBe('(priority:>2) AND NOT status:"inactive"');
    });
  });

  describe('orderBy', () => {
    it('should add an ORDER BY clause', () => {
      const query = builder
        .where('priority', '>', 2)
        .orderBy('title', 'asc')
        .toString();

      expect(query).toBe('priority:>2 ORDER BY title ASC');
    });

    it('should use ASC as default direction', () => {
      const query = builder
        .where('priority', '>', 2)
        .orderBy('title')
        .toString();

      expect(query).toBe('priority:>2 ORDER BY title ASC');
    });
  });

  describe('limit and offset', () => {
    it('should add LIMIT and OFFSET clauses', () => {
      const query = builder
        .where('priority', '>', 2)
        .limit(10)
        .offset(20)
        .toString();

      expect(query).toBe('priority:>2 LIMIT 10 OFFSET 20');
    });
  });

  describe('getExpression', () => {
    it('should return a valid expression', () => {
      const expression = builder
        .where('priority', '>', 2)
        .andWhere('status', '==', 'active')
        .getExpression();

      expect(expression).toEqual({
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'comparison',
          field: 'priority',
          operator: '>',
          value: 2
        },
        right: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'active'
        }
      });
    });
  });

  describe('wildcard support', () => {
    it('should support wildcard syntax in direct query strings', () => {
      const query = builder.where('title:Task*').toString();
      expect(query).toBe('title:Task*'); // Preserves the wildcard in the query
    });

    it('should support wildcard syntax in field-operator-value API', () => {
      const query = builder
        .where('title', 'LIKE' as ComparisonOperator, 'Task*')
        .toString();
      expect(query).toBe('title:Task*'); // Should use the colon format for LIKE
    });

    it('should support combined wildcards', () => {
      const query = builder.where('title:*Important*').toString();
      expect(query).toBe('title:*Important*');
    });

    it('should support ? wildcards', () => {
      const query = builder.where('code:ABC?').toString();
      expect(query).toBe('code:ABC?');
    });
  });

  describe('custom operator handling', () => {
    it('should handle NOT IN operator properly', () => {
      const query = builder
        .where('status', 'NOT IN' as ComparisonOperator, [
          'inactive',
          'deleted'
        ])
        .toString();

      expect(query).toBe('status:not in["inactive","deleted"]');
    });
  });

  describe('constructor options', () => {
    it('should initialize with custom options', () => {
      const options = {
        caseInsensitiveFields: true,
        fieldMappings: { title: 'task_title' }
      };

      const customBuilder = new QueryBuilder<ITodo>(options);
      const query = customBuilder.where('title', '==', 'Bug fix').toString();

      expect(query).toBe('title:"Bug fix"');
    });
  });
});
