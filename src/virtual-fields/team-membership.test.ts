/**
 * Virtual field `team`, the documented list shortcut.
 *
 * `team:assigned` resolves to `assignee_id IN currentUserTeamIds`. A member
 * that is the numeral text `"7"` is the number 7 against a number and the
 * text `7` against a string, the same rule `assignee_id:"7"` already uses.
 * The SQLite column has no affinity, so the stored number and the stored
 * text stay distinct. `not in` uses the same comparison. Inline SQL,
 * parameterized SQL, Drizzle and in-memory filtering return the same ids.
 */

import { integer, sqliteTable } from 'drizzle-orm/sqlite-core';
import { QueryParser } from '../parser';
import { QueryExpression } from '../parser/types';
import { openSqliteHarness } from '../test-support';
import { resolveVirtualFields } from './resolver';
import { IQueryContext, VirtualFieldsConfig } from './types';

interface ITeamContext extends IQueryContext {
  currentUserId: number;
  currentUserTeamIds: Array<number | string | null>;
}

type TaskSchema = {
  tasks: {
    assignee_id: number;
    owner_id: number;
  };
};

const rows: Array<{ id: number; assignee_id: number | string | null }> = [
  { id: 1, assignee_id: 7 },
  { id: 2, assignee_id: 9 },
  { id: 3, assignee_id: null },
  { id: 4, assignee_id: '7' },
  { id: 5, assignee_id: 2 }
];

const tasks = sqliteTable('tasks', {
  id: integer('id'),
  assignee_id: integer('assignee_id')
});

const virtualFields: VirtualFieldsConfig<TaskSchema, ITeamContext> = {
  team: {
    allowedValues: ['assigned', 'owned'] as const,
    resolve: (input, context, { fields }) => {
      const fieldMap = fields({
        assigned: 'assignee_id',
        owned: 'owner_id'
      });
      return {
        type: 'comparison',
        field: fieldMap[input.value as 'assigned' | 'owned'],
        operator: 'IN',
        value: context.currentUserTeamIds
      };
    }
  }
};

const parser = new QueryParser();

function resolveTeam(
  query: string,
  teamIds: ReadonlyArray<number | string | null>
): QueryExpression {
  return resolveVirtualFields(parser.parse(query), virtualFields, {
    currentUserId: 7,
    currentUserTeamIds: [...teamIds]
  });
}

describe('virtual field team membership', () => {
  const harness = openSqliteHarness({
    table: tasks,
    columns: { assignee_id: '' },
    rows
  });

  it.each([
    ['team:assigned', ['7'], [1, 4]],
    ['team:assigned', ['7', 2], [1, 4, 5]],
    ['NOT team:assigned', ['7'], [2, 5]],
    ['team:assigned', ['7', null], [1, 3, 4]]
  ] as const)(
    '%s with %j returns the same ids on every engine',
    (query, teamIds, expectedIds) => {
      harness.expectSameIds(resolveTeam(query, teamIds), [...expectedIds]);
    }
  );

  it.each([
    ['assignee_id:not in["7"]', [2, 5]],
    ['assignee_id:not in["7", 2]', [2]],
    ['assignee_id:not in["7", null]', [2, 5]]
  ] as const)(
    '%s returns the same ids on every engine',
    (query, expectedIds) => {
      harness.expectSameIds(query, [...expectedIds]);
    }
  );
});
