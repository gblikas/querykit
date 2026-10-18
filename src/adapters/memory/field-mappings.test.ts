/**
 * Field mappings on every engine.
 *
 * With `{ status: 'task_status' }`, `status:active` compares the column
 * `task_status` and `ORDER BY status ASC` sorts by it on inline SQL,
 * parameterized SQL, Drizzle and in memory, through the adapters' own
 * `fieldMappings` and through `createQueryKit` with the map on
 * `parserOptions`, whose `orderBy` keys the kit renames before the adapter
 * runs. A mapping that lives on the prototype is not a mapping: the kit
 * rejects the unknown field and the unknown sort key against its schema,
 * the SQL translator keeps the name as written, and the in-memory adapter
 * rejects it as a name no row has.
 */

import { createRequire } from 'module';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DrizzleAdapter } from '../drizzle';
import { inMemoryAdapter } from './index';
import { createQueryKit } from '../../index';
import { QueryParser } from '../../parser';
import { QuerySecurityError } from '../../security';
import { SqlTranslator } from '../../translators/sql';

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
}

interface ISqliteDatabase {
  exec(sqlText: string): void;
  prepare(sqlText: string): ISqliteStatement;
  close(): void;
}

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

interface IParameterizedSql {
  sql: string;
  params: unknown[];
}

interface ITask {
  id: number;
  task_status: string;
}

const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey(),
  task_status: text('task_status')
});

const rows: ITask[] = [
  { id: 1, task_status: 'closed' },
  { id: 2, task_status: 'active' }
];

const fieldMappings = { status: 'task_status' };

/** Ids of rows the kit returned, whose row type is not declared here. */
function idsOf(rows: unknown[]): number[] {
  return (rows as Array<{ id: number }>).map(row => row.id);
}

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, task_status TEXT);
    INSERT INTO tasks VALUES (1, 'closed'), (2, 'active');
  `);
  return database;
}

describe('field mappings', () => {
  const database = openDatabase();
  const db = drizzle(database as never);
  const parser = new QueryParser();
  const mappingParser = new QueryParser({ fieldMappings });
  const drizzleAdapter = new DrizzleAdapter({
    db,
    schema: { tasks },
    fieldMappings
  });
  const memoryAdapter = inMemoryAdapter({
    records: { tasks: rows },
    fieldMappings
  });
  const kits = [
    createQueryKit({
      adapter: new DrizzleAdapter({ db, schema: { tasks } }),
      schema: { tasks },
      parserOptions: { fieldMappings }
    }),
    createQueryKit({
      adapter: inMemoryAdapter({ records: { tasks: rows } }),
      schema: { tasks },
      parserOptions: { fieldMappings }
    })
  ];

  function idsOfSql(statement: string, params: unknown[] = []): number[] {
    return database
      .prepare(`SELECT id FROM tasks WHERE ${statement}`)
      .all(...params)
      .map(row => row.id);
  }

  afterAll((): void => {
    database.close();
  });

  it('compares the mapped column for status:active', async () => {
    const expression = parser.parse('status:active');
    const inline = new SqlTranslator({
      useParameters: false,
      fieldMappings
    }).translate(expression) as string;
    expect(inline).toBe('"task_status" = \'active\'');
    expect(idsOfSql(inline)).toEqual([2]);
    const parameterized = new SqlTranslator({ fieldMappings }).translate(
      expression
    ) as IParameterizedSql;
    expect(parameterized).toEqual({
      sql: '"task_status" = ?',
      params: ['active']
    });
    expect(idsOfSql(parameterized.sql, parameterized.params)).toEqual([2]);
    const viaDrizzle = await drizzleAdapter.execute<ITask>('tasks', expression);
    expect(viaDrizzle.map(row => row.id)).toEqual([2]);
    const inMemory = await memoryAdapter.execute<ITask>('tasks', expression);
    expect(inMemory.map(row => row.id)).toEqual([2]);
    for (const kit of kits) {
      const viaKit = await kit.query('tasks').where('status:active').execute();
      expect(idsOf(viaKit)).toEqual([2]);
    }
  });

  it('sorts by the mapped column for ORDER BY status ASC', async () => {
    const expression = parser.parse('id:>=0');
    const inline = new SqlTranslator({ useParameters: false }).translate(
      expression
    ) as string;
    expect(idsOfSql(`${inline} ORDER BY "task_status" ASC`)).toEqual([2, 1]);
    const parameterized = new SqlTranslator().translate(
      expression
    ) as IParameterizedSql;
    expect(
      idsOfSql(
        `${parameterized.sql} ORDER BY "task_status" ASC`,
        parameterized.params
      )
    ).toEqual([2, 1]);
    const orderBy = { status: 'asc' as const };
    const viaDrizzle = await drizzleAdapter.execute<ITask>(
      'tasks',
      expression,
      { orderBy }
    );
    expect(viaDrizzle.map(row => row.id)).toEqual([2, 1]);
    const inMemory = await memoryAdapter.execute<ITask>('tasks', expression, {
      orderBy
    });
    expect(inMemory.map(row => row.id)).toEqual([2, 1]);
    for (const kit of kits) {
      const viaKit = await kit
        .query('tasks')
        .where('id:>=0')
        .orderBy('status', 'asc')
        .execute();
      expect(idsOf(viaKit)).toEqual([2, 1]);
    }
  });

  // A kit with the inherited mapping rejects `status` as an unknown field
  // and an unknown sort key against its schema, and the bare in-memory
  // adapter rejects it as a name no row has; had the mapping been read,
  // `status` would have resolved to the known `task_status`. The SQL
  // translator keeps the name as written.
  it('does not read a mapping from the prototype', async () => {
    const inherited: Record<string, string> = Object.create(fieldMappings);
    const expression = new QueryParser({ fieldMappings: inherited }).parse(
      'status:active'
    );
    expect(
      new SqlTranslator({
        useParameters: false,
        fieldMappings: inherited
      }).translate(expression)
    ).toBe('"status" = \'active\'');
    const memory = inMemoryAdapter({
      records: { tasks: rows },
      fieldMappings: inherited
    });
    const unmapped = 'Field status does not name a property of table tasks';
    await expect(memory.execute<ITask>('tasks', expression)).rejects.toThrow(
      unmapped
    );
    await expect(
      memory.execute<ITask>('tasks', parser.parse('id:>=0'), {
        orderBy: { status: 'asc' }
      })
    ).rejects.toThrow(unmapped);
    const kit = createQueryKit({
      adapter: inMemoryAdapter({ records: { tasks: rows } }),
      schema: { tasks: { id: {}, task_status: {} } },
      parserOptions: { fieldMappings: inherited }
    });
    await expect(
      kit.query('tasks').where('status:active').execute()
    ).rejects.toThrow(QuerySecurityError);
    await expect(
      kit.query('tasks').where('id:>=0').orderBy('status', 'asc').execute()
    ).rejects.toThrow(QuerySecurityError);
    const mapped = mappingParser.parse('status:active');
    expect(mapped).toEqual({
      type: 'comparison',
      field: 'task_status',
      operator: '==',
      value: 'active'
    });
  });
});
