import { createQueryKit } from '../../index';
import { QueryParseError } from '../../parser/parser';
import { QueryParser } from '../../parser';
import { QueryExpression } from '../../parser/types';
import { QuerySecurityError } from '../../security';
import { DrizzleTranslator } from '../../translators/drizzle';
import {
  filterInMemory,
  InMemoryAdapter,
  InMemoryAdapterError,
  inMemoryAdapter
} from './index';
import { canMatchExpression, filterByExpression } from './match-expression';

interface ITask {
  id: number;
  title: string;
  status: string;
  priority: number;
  assignee_id: number;
}

const inputTasks: ITask[] = [
  {
    id: 1,
    title: 'Buy groceries',
    status: 'active',
    priority: 2,
    assignee_id: 7
  },
  {
    id: 2,
    title: 'Fix bug',
    status: 'inactive',
    priority: 1,
    assignee_id: 8
  },
  {
    id: 3,
    title: 'Ship release',
    status: 'done',
    priority: 3,
    assignee_id: 7
  },
  {
    id: 4,
    title: 'Review',
    status: 'Active',
    priority: 12,
    assignee_id: 9
  },
  {
    id: 5,
    title: 'Wait',
    status: 'pending',
    priority: 2,
    assignee_id: 4
  }
];

const taskSchema = {
  tasks: {
    id: {},
    title: {},
    status: {},
    priority: {},
    assignee_id: {}
  }
};

describe('Drizzle predicate parity', () => {
  interface IPreviewRow {
    id: number;
    status: string;
    priority: number;
    title: string;
  }

  const inputRows: IPreviewRow[] = [
    { id: 1, status: 'active', priority: 2, title: 'Ship release' },
    { id: 2, status: 'inactive', priority: 12, title: 'Ship*' },
    { id: 3, status: 'Active', priority: 2, title: 'ship release' },
    { id: 4, status: 'done', priority: 3, title: 'Other' }
  ];
  const parser = new QueryParser();
  const translator = new DrizzleTranslator();

  it('keeps status:active equal to active and drops inactive', async () => {
    const expression = parser.parse('status:active');
    const translated = JSON.stringify(translator.translate(expression));
    expect(expression).toMatchObject({
      type: 'comparison',
      operator: '==',
      value: 'active'
    });
    expect(translated).toContain('=');
    expect(
      filterInMemory('status:active', inputRows).map(row => row.id)
    ).toEqual([1]);
    const kit = createQueryKit({
      adapter: inMemoryAdapter({ records: { rows: inputRows } }),
      schema: { rows: { id: {}, status: {}, priority: {}, title: {} } }
    });
    const actual = await kit.query('rows').where('status:active').execute();
    expect(actual).toEqual([inputRows[0]]);
  });

  it('keeps priority:2 equal to 2 and drops 12', () => {
    const expression = parser.parse('priority:2');
    expect(expression).toMatchObject({
      type: 'comparison',
      operator: '==',
      value: 2
    });
    expect(JSON.stringify(translator.translate(expression))).toContain('=');
    expect(filterInMemory('priority:2', inputRows).map(row => row.id)).toEqual([
      1, 3
    ]);
    expect(filterInMemory('priority:=2', inputRows).map(row => row.id)).toEqual(
      [1, 3]
    );
  });

  it('treats a quoted asterisk and an unquoted wildcard as Drizzle LIKE', () => {
    const wildcard = parser.parse('title:Ship*');
    const quoted = parser.parse('title:"Ship*"');
    expect(wildcard).toMatchObject({ operator: 'LIKE', value: 'Ship*' });
    expect(quoted).toMatchObject({ operator: 'LIKE', value: 'Ship*' });
    expect(JSON.stringify(translator.translate(wildcard))).toContain('LIKE');
    expect(JSON.stringify(translator.translate(quoted))).toContain('LIKE');
    // SQLite's LIKE folds ASCII case, so `ship release` matches as well.
    expect(filterInMemory('title:Ship*', inputRows).map(row => row.id)).toEqual(
      [1, 2, 3]
    );
    expect(
      filterInMemory('title:"Ship*"', inputRows).map(row => row.id)
    ).toEqual([1, 2, 3]);
  });
});

describe('in-memory filtering', () => {
  describe('filterInMemory', () => {
    it('filters with the same QueryKit string the Drizzle adapter compiles', () => {
      const actual = filterInMemory('status:done AND priority:>2', inputTasks);
      expect(actual).toEqual([inputTasks[2]]);
    });

    it('accepts lowercase boolean operators from the QueryKit string', () => {
      const actual = filterInMemory('status:done and priority:>2', inputTasks);
      expect(actual).toEqual([inputTasks[2]]);
    });

    it('accepts QueryKit bracket lists as equality OR', () => {
      const actual = filterInMemory('status:[done, pending]', inputTasks);
      expect(actual.map(task => task.id)).toEqual([3, 5]);
    });

    it('matches status:active as equality, so inactive and Active stay out', () => {
      const actual = filterInMemory('status:active', inputTasks);
      expect(actual.map(task => task.id)).toEqual([1]);
    });

    it('matches a quoted literal with case-sensitive equality', () => {
      const actual = filterInMemory('status:"Active"', inputTasks);
      expect(actual).toEqual([inputTasks[3]]);
    });

    it('treats priority:2 and priority:=2 as the same equality', () => {
      const colonMatches = filterInMemory('priority:2', inputTasks);
      const exactMatches = filterInMemory('priority:=2', inputTasks);
      expect(colonMatches.map(task => task.id)).toEqual([1, 5]);
      expect(exactMatches.map(task => task.id)).toEqual([1, 5]);
    });

    it('matches an inclusive range as greater-or-equal and less-or-equal', () => {
      const actual = filterInMemory('priority:[2 TO 3]', inputTasks);
      expect(actual.map(task => task.id)).toEqual([1, 3, 5]);
    });

    it('treats a quoted asterisk and an unquoted wildcard as the same LIKE', () => {
      const wildcardMatches = filterInMemory('title:Ship*', inputTasks);
      const quotedMatches = filterInMemory('title:"Ship*"', inputTasks);
      expect(wildcardMatches).toEqual([inputTasks[2]]);
      expect(quotedMatches).toEqual([inputTasks[2]]);
    });

    it('rejects a slash pattern that contains * as an unsupported REGEX operator', () => {
      const filterSlashPattern = (): ITask[] =>
        filterInMemory('title:/Ship.*/', inputTasks);
      expect(filterSlashPattern).toThrow(InMemoryAdapterError);
      expect(filterSlashPattern).toThrow('Unsupported operator: REGEX');
    });

    it('matches ? and escaped percent the way SQL LIKE does', () => {
      const titles = [
        { id: 1, title: 'Ship' },
        { id: 2, title: 'Shop' },
        { id: 3, title: 'Sheep' },
        { id: 4, title: 'ship' },
        { id: 5, title: null }
      ];
      const notes = [
        { id: 1, note: '100% off' },
        { id: 2, note: '100 off' },
        { id: 3, note: '100%off' }
      ];
      expect(filterInMemory('title:Sh?p', titles).map(row => row.id)).toEqual([
        1, 2, 4
      ]);
      expect(filterInMemory('note:"100%*"', notes).map(row => row.id)).toEqual([
        1, 3
      ]);
      expect(filterInMemory('title:<s', titles).map(row => row.id)).toEqual([
        1, 2, 3
      ]);
      expect(
        filterInMemory('NOT title:Sh?p', titles).map(row => row.id)
      ).toEqual([3]);
    });

    it('treats a space between clauses as AND', () => {
      const actual = filterInMemory('status:done priority:>2', inputTasks);
      expect(actual).toEqual([inputTasks[2]]);
    });

    it('excludes rows that match the negated comparison', () => {
      const actual = filterInMemory('NOT status:done', inputTasks);
      expect(actual).toEqual([
        inputTasks[0],
        inputTasks[1],
        inputTasks[3],
        inputTasks[4]
      ]);
    });

    it('lowercases field names when case-insensitive fields are enabled', () => {
      const actual = filterInMemory('Status:done', inputTasks, {
        caseInsensitiveFields: true
      });
      expect(actual).toEqual([inputTasks[2]]);
    });

    it('returns an empty array when nothing matches', () => {
      expect(filterInMemory('status:archived', inputTasks)).toEqual([]);
    });

    it('returns the same row objects and does not reorder the input', () => {
      const inputIds = inputTasks.map(task => task.id);
      const actual = filterInMemory('status:done', inputTasks);
      expect(actual[0]).toBe(inputTasks[2]);
      expect(inputTasks.map(task => task.id)).toEqual(inputIds);
    });

    it('applies parser field mappings before reading field names', () => {
      const inputRows = [
        { task_status: 'done', priority: 3 },
        { task_status: 'active', priority: 1 }
      ];
      const actual = filterInMemory('status:done', inputRows, {
        fieldMappings: { status: 'task_status' }
      });
      expect(actual).toEqual([inputRows[0]]);
    });

    it('rejects a query the QueryKit parser rejects', () => {
      expect(() => filterInMemory('status:done AND', inputTasks)).toThrow(
        QueryParseError
      );
    });
  });

  describe('InMemoryAdapter', () => {
    const adapter = inMemoryAdapter({
      records: { tasks: inputTasks }
    });

    it('forwards field mappings so the string matches fetched column names', async () => {
      const inputRows = [{ task_status: 'done' }, { task_status: 'active' }];
      const mappedAdapter = inMemoryAdapter({
        records: { tasks: inputRows }
      });
      const kit = createQueryKit({
        adapter: mappedAdapter,
        schema: { tasks: { task_status: {} } },
        parserOptions: {
          fieldMappings: { status: 'task_status' }
        }
      });
      const actual = await kit.query('tasks').where('status:done').execute();
      expect(actual).toEqual([inputRows[0]]);
    });

    it('orders string fields without ranking', async () => {
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'priority',
        operator: '>=',
        value: 1
      };
      const actual = await adapter.execute<ITask>('tasks', expression, {
        orderBy: { title: 'asc' },
        limit: 1
      });
      expect(actual).toEqual([inputTasks[0]]);
    });

    it('filters a fetched page through createQueryKit with that same string', async () => {
      const query = 'status:done AND priority:>2';
      const expected = filterInMemory(query, inputTasks);
      const kit = createQueryKit({
        adapter,
        schema: taskSchema
      });
      const actual = await kit.query('tasks').where(query).execute();
      expect(actual).toEqual(expected);
    });

    it('applies order, limit, and offset after the filter', async () => {
      const kit = createQueryKit({
        adapter,
        schema: taskSchema
      });
      const actual = await kit
        .query('tasks')
        .where('priority:>=1')
        .orderBy('priority', 'desc')
        .offset(1)
        .limit(1)
        .execute();
      expect(actual).toEqual([inputTasks[2]]);
    });

    it('uses the autofixed string in tolerant mode', async () => {
      const kit = createQueryKit({
        adapter,
        schema: taskSchema,
        tolerant: true
      });
      const actual = await kit
        .query('tasks')
        .where('status:done AND')
        .execute();
      expect(actual).toEqual([inputTasks[2]]);
    });

    it('still enforces denied fields before filtering', async () => {
      const kit = createQueryKit({
        adapter,
        schema: taskSchema,
        security: { denyFields: ['title'] }
      });
      await expect(
        kit.query('tasks').where('title:Ship*').execute()
      ).rejects.toThrow(QuerySecurityError);
    });

    it('applies enforced exclusions to the filtered rows', async () => {
      const kit = createQueryKit({
        adapter,
        schema: taskSchema,
        security: {
          enforceExcludedValues: { status: ['done'] }
        }
      });
      const actual = await kit.query('tasks').where('priority:>0').execute();
      expect(actual).toEqual([
        inputTasks[0],
        inputTasks[1],
        inputTasks[3],
        inputTasks[4]
      ]);
    });

    it('filters virtual fields after they resolve to real columns', async () => {
      const kit = createQueryKit({
        adapter,
        schema: taskSchema,
        virtualFields: {
          my: {
            allowedValues: ['assigned'] as const,
            resolve: (_input, context) => ({
              type: 'comparison' as const,
              field: 'assignee_id',
              operator: '==' as const,
              value: context.currentUserId
            })
          }
        },
        createContext: () => ({ currentUserId: 7 })
      });
      const actual = await kit.query('tasks').where('my:assigned').execute();
      expect(actual).toEqual([inputTasks[0], inputTasks[2]]);
    });

    it('filters a resolved expression when no query string is supplied', async () => {
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'assignee_id',
        operator: '==',
        value: 7
      };
      expect(adapter.canExecute(expression)).toBe(true);
      const actual = await adapter.execute<ITask>('tasks', expression);
      expect(actual.map(task => task.id)).toEqual([1, 3]);
    });

    it('throws when the table is not in the fetched records', async () => {
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'done'
      };
      await expect(adapter.execute('missing', expression)).rejects.toThrow(
        'Table missing not found in records'
      );
    });

    it('rejects raw SQL instead of evaluating it in process', async () => {
      const expression: QueryExpression = {
        type: 'raw',
        toSql: () => 'status = done'
      };
      await expect(adapter.execute('tasks', expression)).rejects.toThrow(
        'Raw SQL'
      );
      expect(adapter.canExecute(expression)).toBe(false);
    });

    it('rejects a negative limit', async () => {
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'done'
      };
      await expect(
        adapter.execute('tasks', expression, { limit: -1 })
      ).rejects.toThrow('Limit must be a non-negative integer');
    });

    it('evaluates equality, LIKE, and NOT on a resolved expression', async () => {
      const phrase: QueryExpression = {
        type: 'comparison',
        field: 'title',
        operator: '==',
        value: 'Buy groceries'
      };
      const like: QueryExpression = {
        type: 'comparison',
        field: 'title',
        operator: 'LIKE',
        value: 'Ship*'
      };
      const excluded: QueryExpression = {
        type: 'logical',
        operator: 'NOT',
        left: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'done'
        }
      };
      const phraseMatches = await adapter.execute<ITask>('tasks', phrase);
      const likeMatches = await adapter.execute<ITask>('tasks', like);
      const kept = await adapter.execute<ITask>('tasks', excluded);
      expect(phraseMatches).toEqual([inputTasks[0]]);
      expect(likeMatches).toEqual([inputTasks[2]]);
      expect(kept.map(task => task.id)).toEqual([1, 2, 4, 5]);
    });

    it('follows SQL null, inequality, and membership', async () => {
      const inputRows = [
        { flag: true, label: 'yes' },
        { flag: false, label: 'no' },
        { flag: null, label: 'empty' }
      ];
      const flagAdapter = inMemoryAdapter({ records: { flags: inputRows } });
      const truths = await flagAdapter.execute('flags', {
        type: 'comparison',
        field: 'flag',
        operator: '==',
        value: true
      });
      const empties = await flagAdapter.execute('flags', {
        type: 'comparison',
        field: 'flag',
        operator: '==',
        value: null
      });
      const notFalse = await flagAdapter.execute('flags', {
        type: 'comparison',
        field: 'flag',
        operator: '!=',
        value: false
      });
      const notTrue = await flagAdapter.execute('flags', {
        type: 'logical',
        operator: 'NOT',
        left: {
          type: 'comparison',
          field: 'flag',
          operator: '==',
          value: true
        }
      });
      const members = await adapter.execute<ITask>('tasks', {
        type: 'comparison',
        field: 'priority',
        operator: 'IN',
        value: [1, 3]
      });
      const excluded = await adapter.execute<ITask>('tasks', {
        type: 'comparison',
        field: 'status',
        operator: 'NOT IN',
        value: ['done', 'pending']
      });
      expect(truths).toEqual([inputRows[0]]);
      expect(empties).toEqual([inputRows[2]]);
      expect(notFalse).toEqual([inputRows[0]]);
      expect(notTrue).toEqual([inputRows[1]]);
      expect(members.map(task => task.id)).toEqual([2, 3]);
      expect(excluded.map(task => task.id)).toEqual([1, 2, 4]);
    });

    it('rejects an incomplete boolean and a non-string LIKE', async () => {
      const incomplete: QueryExpression = {
        type: 'logical',
        operator: 'AND',
        left: {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: 'done'
        }
      };
      expect(adapter.canExecute(incomplete)).toBe(false);
      await expect(adapter.execute('tasks', incomplete)).rejects.toThrow(
        'missing a right operand'
      );
      const emptyIn = await adapter.execute<ITask>('tasks', {
        type: 'comparison',
        field: 'status',
        operator: 'IN',
        value: []
      });
      const emptyNotIn = await adapter.execute<ITask>('tasks', {
        type: 'comparison',
        field: 'status',
        operator: 'NOT IN',
        value: []
      });
      const beyond = await adapter.execute<ITask>('tasks', {
        type: 'comparison',
        field: 'priority',
        operator: '>',
        value: Number.POSITIVE_INFINITY
      });
      expect(emptyIn).toEqual([]);
      expect(emptyNotIn).toEqual(inputTasks);
      expect(beyond).toEqual([]);
      await expect(
        adapter.execute('tasks', {
          type: 'comparison',
          field: 'title',
          operator: 'LIKE',
          value: 1
        })
      ).rejects.toThrow('LIKE operator requires a string value');
    });

    it('rejects a missing record map and a negative offset', async () => {
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'done'
      };
      expect(() =>
        adapter.initialize({
          records: undefined as unknown as Record<string, readonly object[]>
        })
      ).toThrow('Records are required');
      adapter.initialize({ records: { tasks: inputTasks } });
      await expect(
        adapter.execute('tasks', expression, { offset: -1 })
      ).rejects.toThrow('Offset must be a non-negative integer');
    });

    it('reports that it cannot execute before initialization', async () => {
      const bareAdapter = new InMemoryAdapter();
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'done'
      };
      expect(bareAdapter.canExecute(expression)).toBe(false);
      await expect(bareAdapter.execute('tasks', expression)).rejects.toThrow(
        'Adapter has not been initialized'
      );
    });

    it('matches null rows for equality with null the way IS NULL does', async () => {
      const inputRows = [
        { id: 1, status: 'open' },
        { id: 2, status: null },
        { id: 3, status: 'closed' }
      ];
      const rowsAdapter = inMemoryAdapter({ records: { items: inputRows } });
      const equalsNull = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        {
          type: 'comparison',
          field: 'status',
          operator: '==',
          value: null
        }
      );
      const notNull = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        {
          type: 'comparison',
          field: 'status',
          operator: '!=',
          value: null
        }
      );
      const onlyNull = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        {
          type: 'comparison',
          field: 'status',
          operator: 'IN',
          value: [null]
        }
      );
      const openOrNull = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        {
          type: 'comparison',
          field: 'status',
          operator: 'IN',
          value: [null, 'open']
        }
      );
      const notClosed = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        {
          type: 'comparison',
          field: 'status',
          operator: 'NOT IN',
          value: [null, 'closed']
        }
      );
      const aboveNull = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        {
          type: 'comparison',
          field: 'status',
          operator: '>',
          value: null
        }
      );
      expect(equalsNull.map(row => row.id)).toEqual([2]);
      expect(notNull.map(row => row.id)).toEqual([1, 3]);
      expect(onlyNull.map(row => row.id)).toEqual([2]);
      expect(openOrNull.map(row => row.id)).toEqual([1, 2]);
      expect(notClosed.map(row => row.id)).toEqual([1]);
      expect(aboveNull).toEqual([]);
    });

    it('matches a literal backslash before a wildcard the way SQL LIKE does', async () => {
      const inputRows = [
        { id: 1, name: 'foo\\bar' },
        { id: 2, name: 'foo%' },
        { id: 3, name: 'foobar' }
      ];
      const rowsAdapter = inMemoryAdapter({ records: { items: inputRows } });
      const actual = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        {
          type: 'comparison',
          field: 'name',
          operator: 'LIKE',
          value: 'foo\\*'
        }
      );
      expect(actual.map(row => row.id)).toEqual([1]);
    });

    it('does not read inherited object properties as field values', async () => {
      const inputRows = [
        { id: 1, toString: 'alpha' },
        { id: 2, name: 'beta' },
        { id: 3, toString: 'beta' }
      ];
      const rowsAdapter = inMemoryAdapter({ records: { items: inputRows } });
      const actual = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        {
          type: 'comparison',
          field: 'toString',
          operator: '!=',
          value: 'alpha'
        }
      );
      expect(actual.map(row => row.id)).toEqual([3]);
    });

    it('sorts nulls before other values', async () => {
      const inputRows = [
        { id: 1, priority: 2 },
        { id: 2, priority: null },
        { id: 3, priority: 1 }
      ];
      const rowsAdapter = inMemoryAdapter({ records: { items: inputRows } });
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'id',
        operator: '>',
        value: 0
      };
      const ascending = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        expression,
        { orderBy: { priority: 'asc' } }
      );
      const descending = await rowsAdapter.execute<(typeof inputRows)[number]>(
        'items',
        expression,
        { orderBy: { priority: 'desc' } }
      );
      expect(ascending.map(row => row.id)).toEqual([2, 3, 1]);
      expect(descending.map(row => row.id)).toEqual([1, 3, 2]);
    });

    it('reports a missing table when the name is an inherited property', async () => {
      const expression: QueryExpression = {
        type: 'comparison',
        field: 'id',
        operator: '==',
        value: 1
      };
      await expect(adapter.execute('toString', expression)).rejects.toThrow(
        'Table toString not found in records'
      );
    });
  });
});

describe('InMemoryAdapter sort direction validation', () => {
  const rows = [{ id: 2 }, { id: 1 }, { id: 3 }];
  const expression: QueryExpression = {
    type: 'comparison',
    field: 'id',
    operator: '>',
    value: 0
  };

  it('rejects a direction that is neither asc nor desc instead of sorting ascending', async () => {
    const rowsAdapter = inMemoryAdapter({ records: { items: rows } });
    await expect(
      rowsAdapter.execute('items', expression, {
        orderBy: { id: 'invalid' as 'asc' }
      })
    ).rejects.toThrow('Invalid sort direction: invalid');
  });

  it('accepts asc and desc in any letter case', async () => {
    const rowsAdapter = inMemoryAdapter({ records: { items: rows } });
    const descending = await rowsAdapter.execute<{ id: number }>(
      'items',
      expression,
      { orderBy: { id: 'DESC' as 'desc' } }
    );
    expect(descending.map(row => row.id)).toEqual([3, 2, 1]);
  });
});

describe('InMemoryAdapter field mappings', () => {
  const inputRows = [
    { task_status: 'active', task_priority: 2, toString: 'own' },
    { task_status: 'done', task_priority: 1, toString: 'own' }
  ];
  const mappedAdapter = inMemoryAdapter({
    records: { tasks: inputRows },
    fieldMappings: { status: 'task_status', priority: 'task_priority' }
  });

  it('applies adapter field mappings to comparison fields', async () => {
    const actual = await mappedAdapter.execute('tasks', {
      type: 'comparison',
      field: 'status',
      operator: '==',
      value: 'active'
    });
    expect(actual).toEqual([inputRows[0]]);
  });

  it('applies adapter field mappings to sort fields', async () => {
    const actual = await mappedAdapter.execute(
      'tasks',
      { type: 'comparison', field: 'priority', operator: '>', value: 0 },
      { orderBy: { priority: 'asc' } }
    );
    expect(actual).toEqual([inputRows[1], inputRows[0]]);
  });

  it('keeps the first direction when a mapped sort field collides with its target', async () => {
    const actual = await mappedAdapter.execute(
      'tasks',
      { type: 'comparison', field: 'priority', operator: '>', value: 0 },
      { orderBy: { priority: 'asc', task_priority: 'desc' } }
    );
    expect(actual).toEqual([inputRows[1], inputRows[0]]);
  });

  it('applies adapter field mappings to membership fields', async () => {
    const actual = await mappedAdapter.execute('tasks', {
      type: 'comparison',
      field: 'status',
      operator: 'NOT IN',
      value: ['done']
    });
    expect(actual).toEqual([inputRows[0]]);
  });

  it('applies adapter mappings after parser mappings and enforced exclusions', async () => {
    const queryKit = createQueryKit({
      adapter: mappedAdapter,
      schema: { tasks: { status: {}, priority: {} } },
      parserOptions: { fieldMappings: { state: 'status' } },
      security: { enforceExcludedValues: { status: ['done'] } }
    });
    const actual = await queryKit
      .query('tasks')
      .where('state:active OR state:done')
      .execute();
    expect(actual).toEqual([inputRows[0]]);
  });

  it('maps fields nested under logical operators', async () => {
    const expression: QueryExpression = {
      type: 'logical',
      operator: 'AND',
      left: {
        type: 'comparison',
        field: 'status',
        operator: '==',
        value: 'done'
      },
      right: { type: 'comparison', field: 'priority', operator: '>=', value: 1 }
    };
    const actual = await mappedAdapter.execute('tasks', expression);
    expect(actual).toEqual([inputRows[1]]);
  });

  it('does not map a field through the object prototype', async () => {
    const actual = await mappedAdapter.execute('tasks', {
      type: 'comparison',
      field: 'toString',
      operator: '==',
      value: 'own'
    });
    expect(actual).toEqual(inputRows);
  });
});

describe('InMemoryAdapter canExecute shape checks', () => {
  const rowsAdapter = inMemoryAdapter({ records: { items: [{ name: 'x' }] } });

  it('reports false for comparisons execute() would reject', async () => {
    const rejected: QueryExpression[] = [
      { type: 'comparison', field: 'name', operator: 'REGEX', value: 'x' },
      { type: 'comparison', field: 'name', operator: 'LIKE', value: 5 },
      { type: 'comparison', field: 'name', operator: 'IN', value: 'x' },
      { type: 'comparison', field: 'name', operator: 'NOT IN', value: 'x' }
    ];
    for (const expression of rejected) {
      expect(rowsAdapter.canExecute(expression)).toBe(false);
      await expect(rowsAdapter.execute('items', expression)).rejects.toThrow(
        InMemoryAdapterError
      );
    }
  });

  it('reports true for comparisons execute() accepts', () => {
    const accepted: QueryExpression[] = [
      { type: 'comparison', field: 'name', operator: 'LIKE', value: 'x*' },
      { type: 'comparison', field: 'name', operator: 'IN', value: ['x'] },
      { type: 'comparison', field: 'name', operator: '==', value: null }
    ];
    for (const expression of accepted) {
      expect(rowsAdapter.canExecute(expression)).toBe(true);
    }
  });
});

describe('InMemoryAdapter validates expressions before reading rows', () => {
  const noRows: ITask[] = [];

  it('rejects a REGEX query even when there are no rows', () => {
    const filterNoRows = (): ITask[] => filterInMemory('title:/foo/', noRows);
    expect(filterNoRows).toThrow(InMemoryAdapterError);
    expect(filterNoRows).toThrow('Unsupported operator: REGEX');
  });

  it('rejects malformed expressions against an empty table', () => {
    const nameIsX: QueryExpression = {
      type: 'comparison',
      field: 'name',
      operator: '==',
      value: 'x'
    };
    const rejected: Array<{ expression: QueryExpression; message: string }> = [
      {
        expression: {
          type: 'comparison',
          field: 'name',
          operator: 'LIKE',
          value: 5
        },
        message: 'LIKE operator requires a string value'
      },
      {
        expression: {
          type: 'comparison',
          field: 'name',
          operator: 'IN',
          value: 'x'
        },
        message: 'IN operator requires an array value'
      },
      {
        expression: { type: 'logical', operator: 'AND', left: nameIsX },
        message: 'Logical expression is missing a right operand'
      },
      {
        expression: { type: 'raw', toSql: (): string => '' },
        message: 'Raw SQL expressions cannot be filtered in memory'
      },
      {
        expression: {
          type: 'comparison',
          field: 'name',
          operator: 'CONTAINS',
          value: 'x'
        } as unknown as QueryExpression,
        message: 'Unsupported operator: CONTAINS'
      },
      {
        expression: {
          type: 'logical',
          operator: 'XOR',
          left: nameIsX,
          right: nameIsX
        } as unknown as QueryExpression,
        message: 'Unsupported logical operator: XOR'
      },
      {
        expression: {
          type: 'logical',
          operator: 'AND',
          right: nameIsX
        } as unknown as QueryExpression,
        message: 'Logical expression is missing a left operand'
      }
    ];
    for (const { expression, message } of rejected) {
      expect(() => filterByExpression(expression, noRows)).toThrow(message);
      expect(() => filterByExpression(expression, [{ name: 'x' }])).toThrow(
        message
      );
      expect(canMatchExpression(expression)).toBe(false);
    }
  });

  it('rejects through the adapter on an empty table and reports canExecute false', async () => {
    const adapter = inMemoryAdapter({ records: { tasks: noRows } });
    const regex: QueryExpression = {
      type: 'comparison',
      field: 'title',
      operator: 'REGEX',
      value: '/foo/'
    };
    expect(adapter.canExecute(regex)).toBe(false);
    await expect(adapter.execute('tasks', regex)).rejects.toThrow(
      'Unsupported operator: REGEX'
    );
  });

  it('rejects an offending node nested under NOT and OR on an empty table', () => {
    const nested: QueryExpression = {
      type: 'logical',
      operator: 'NOT',
      left: {
        type: 'logical',
        operator: 'OR',
        left: {
          type: 'comparison',
          field: 'title',
          operator: '==',
          value: 'x'
        },
        right: {
          type: 'comparison',
          field: 'title',
          operator: 'LIKE',
          value: 5
        }
      }
    };
    expect(() => filterByExpression(nested, noRows)).toThrow(
      'LIKE operator requires a string value'
    );
  });

  it('still accepts a well-formed expression against an empty table', () => {
    expect(filterInMemory('title:open', noRows)).toEqual([]);
  });
});

describe('InMemoryAdapter LIKE matching is linear', () => {
  it('does not backtrack catastrophically on repeated wildcards', () => {
    const rows = [{ name: 'a'.repeat(5000) }, { name: 'a'.repeat(50) + 'b' }];
    const started = Date.now();
    const unmatched = filterInMemory(`name:${'*a'.repeat(10)}b`, rows);
    const elapsed = Date.now() - started;
    expect(unmatched.map(row => row.name.length)).toEqual([51]);
    expect(elapsed).toBeLessThan(2000);
  });

  it('stays fast through createQueryKit with a pattern the validator allows', async () => {
    const rows = [{ name: 'a'.repeat(20000) }];
    const queryKit = createQueryKit({
      adapter: inMemoryAdapter({ records: { items: rows } }),
      schema: { items: { name: '' } }
    });
    const started = Date.now();
    await expect(
      queryKit.query('items').where('name:*a*a*a*ab').execute()
    ).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps LIKE semantics after the engine change', () => {
    const rows = [
      { id: 1, name: 'abc' },
      { id: 2, name: 'aXc' },
      { id: 3, name: 'ac' },
      { id: 4, name: 'abbc' },
      { id: 5, name: 'xabc' },
      { id: 6, name: 'ab\nc' },
      { id: 7, name: '😀bc' }
    ];
    const ids = (query: string): number[] =>
      filterInMemory(query, rows).map(row => row.id);
    expect(ids('name:a*c')).toEqual([1, 2, 3, 4, 6]);
    expect(ids('name:a?c')).toEqual([1, 2]);
    expect(ids('name:*bc')).toEqual([1, 4, 5, 7]);
    expect(ids('name:?bc')).toEqual([1, 7]);
    expect(ids('name:a**c')).toEqual([1, 2, 3, 4, 6]);
    expect(ids('name:*')).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(ids('name:"ab*"')).toEqual([1, 4, 6]);
  });
});
