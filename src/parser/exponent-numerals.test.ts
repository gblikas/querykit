/**
 * Exponent numerals on equality, order, lists, and ranges.
 *
 * The query builder writes a number with `String(value)`, so `1e-7` reaches
 * the parser as `priority:1e-7`, a spelling Liqe's decimal grammar does not
 * accept. The parser spells an unquoted exponent numeral as a plain decimal
 * before Liqe sees it, outside quotes and regex literals, so equality, the
 * ordered operators, bracket lists, ranges and membership lists all carry
 * the number. An exponent that spells an integer outside the signed 64-bit
 * range is rejected instead, so `1e21` and `1.5e21` do not parse.
 */

import { createRequire } from 'module';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { filterInMemory } from '../adapters/memory';
import { QueryBuilder } from '../query/builder';
import { DrizzleTranslator } from '../translators/drizzle';
import { SqlTranslator } from '../translators/sql';
import { QueryParseError, QueryParser } from './parser';
import { IComparisonExpression, QueryExpression } from './types';

const nodeRequire = createRequire(__filename);

interface ISqliteStatement {
  all(...params: unknown[]): Array<{ id: number }>;
  run(...params: unknown[]): unknown;
}

interface ISqliteDatabase {
  exec(sqlText: string): void;
  prepare(sqlText: string): ISqliteStatement;
  close(): void;
}

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

interface IItem {
  id: number;
  priority: number;
  name: string;
}

interface IParameterizedSql {
  sql: string;
  params: unknown[];
}

const rows: IItem[] = [
  { id: 1, priority: 1e-7, name: '1e-7' },
  { id: 2, priority: 2000, name: 'two thousand' },
  { id: 3, priority: -150, name: 'minus' },
  { id: 4, priority: 10, name: 'ten' }
];

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(
    'CREATE TABLE items (id INTEGER PRIMARY KEY, priority REAL, name TEXT)'
  );
  const insert = database.prepare(
    'INSERT INTO items (id, priority, name) VALUES (?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(row.id, row.priority, row.name);
  }
  return database;
}

function comparison(
  operator: IComparisonExpression['operator'],
  value: IComparisonExpression['value'],
  field = 'priority'
): IComparisonExpression {
  return { type: 'comparison', field, operator, value };
}

describe('exponent numerals', () => {
  const parser = new QueryParser();
  const dialect = new SQLiteSyncDialect();
  const database = openDatabase();

  afterAll((): void => {
    database.close();
  });

  function idsOfSql(statement: IParameterizedSql): number[] {
    return database
      .prepare(`SELECT id FROM items WHERE ${statement.sql} ORDER BY id`)
      .all(...statement.params)
      .map(row => row.id);
  }

  function parameterizedSql(query: string): IParameterizedSql {
    const translated = new SqlTranslator({ useParameters: true }).translate(
      parser.parse(query)
    );
    if (typeof translated === 'string') {
      throw new Error('expected a parameterized statement');
    }
    return translated;
  }

  function drizzleSql(query: string): IParameterizedSql {
    const compiled = dialect.sqlToQuery(
      new DrizzleTranslator().translate(parser.parse(query))
    );
    return { sql: compiled.sql, params: compiled.params };
  }

  it.each([
    ['==', '1e-7'],
    ['>', '1e-7'],
    ['>=', '1e-7'],
    ['<', '1e-7'],
    ['<=', '1e-7']
  ])(
    'parses the builder spelling of 1e-7 under %s as the number',
    (operator, written) => {
      const builder = new QueryBuilder<IItem>().where(
        'priority',
        operator as '==' | '>' | '>=' | '<' | '<=',
        1e-7
      );
      expect(builder.toString()).toContain(`priority:`);
      expect(builder.toString()).toContain(written);
      expect(parser.parse(builder.toString())).toEqual(
        comparison(operator as IComparisonExpression['operator'], 1e-7)
      );
    }
  );

  it('parses the builder spelling of 1e-7 under != as a negated equality', () => {
    const builder = new QueryBuilder<IItem>().where('priority', '!=', 1e-7);
    expect(parser.parse(builder.toString())).toEqual({
      type: 'logical',
      operator: 'NOT',
      left: comparison('==', 1e-7)
    });
  });

  it('spells every member of a bracket list', () => {
    expect(parser.parse('priority:[1e-7, 2E3, -1.5e+2]')).toEqual({
      type: 'logical',
      operator: 'OR',
      left: {
        type: 'logical',
        operator: 'OR',
        left: comparison('==', 1e-7),
        right: comparison('==', 2000)
      },
      right: comparison('==', -150)
    });
  });

  it('keeps an exponent range bound numeric instead of quoting it', () => {
    expect(parser.parse('priority:[1e-7 TO 1e3]')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('>=', 1e-7),
      right: comparison('<=', 1000)
    });
    expect(parser.parse('priority:{-1.5e+2 TO 2E3}')).toEqual({
      type: 'logical',
      operator: 'AND',
      left: comparison('>', -150),
      right: comparison('<', 2000)
    });
  });

  it('keeps membership members numeric', () => {
    expect(parser.parse('priority:in[1e-7, 2E3, -1.5e+2]')).toEqual(
      comparison('IN', [1e-7, 2000, -150])
    );
    expect(parser.parse('priority:not in[1e-7, 2E3, -1.5e+2]')).toEqual(
      comparison('NOT IN', [1e-7, 2000, -150])
    );
  });

  it('keeps a quoted exponent a string', () => {
    expect(parser.parse('priority:"1e-7"')).toEqual(comparison('==', '1e-7'));
    expect(parser.parse("priority:'2E3'")).toEqual(comparison('==', '2E3'));
  });

  it('keeps a regex literal and a field name as written', () => {
    expect(parser.parse('name:/1e-7/')).toEqual(
      comparison('REGEX', '/1e-7/', 'name')
    );
    expect(parser.parse('batch1e2:1')).toEqual(comparison('==', 1, 'batch1e2'));
  });

  it('spells a negative fraction the way the builder already does', () => {
    const builder = new QueryBuilder<IItem>().where('priority', '==', -2.5e-3);
    expect(builder.toString()).toBe('priority:-0.0025');
    expect(parser.parse(builder.toString())).toEqual(comparison('==', -0.0025));
    expect(parser.parse('priority:-2.5e-3')).toEqual(comparison('==', -0.0025));
  });

  it('leaves an exponent above the spelling limit to Liqe', () => {
    expect(() => parser.parse('priority:1e401')).toThrow(QueryParseError);
    expect(() => parser.parse('priority:1e401')).toThrow(/Syntax error/);
    expect(() => parser.parse('priority:1e-401')).toThrow(/Syntax error/);
  });

  it.each(['1e21', '1e+21', '1E21', '1.5e21', '-1e21'])(
    'rejects %s as an integer outside the signed 64-bit range',
    written => {
      const parse = (): QueryExpression => parser.parse(`priority:${written}`);
      expect(parse).toThrow(QueryParseError);
      expect(parse).toThrow(
        `Integer is outside the signed 64-bit range: ${written}`
      );
    }
  );

  it('binds the number 1e-7 through parameterized SQL', () => {
    const statement = parameterizedSql('priority:1e-7');
    expect(statement).toEqual({ sql: '"priority" = ?', params: [1e-7] });
    expect(idsOfSql(statement)).toEqual([1]);
  });

  it('writes the number 1e-7 into inline SQL', () => {
    const inline = new SqlTranslator({ useParameters: false }).translate(
      parser.parse('priority:1e-7')
    );
    expect(inline).toBe(
      '("priority" IS NULL AND NULL) OR (typeof("priority") IN (\'integer\', \'real\') AND "priority" = 1e-7)'
    );
    expect(idsOfSql({ sql: inline as string, params: [] })).toEqual([1]);
  });

  it('binds the number 1e-7 through the Drizzle translator', () => {
    const statement = drizzleSql('priority:1e-7');
    expect(statement).toEqual({ sql: '"priority" = ?', params: [1e-7] });
    expect(idsOfSql(statement)).toEqual([1]);
  });

  it('compares the number 1e-7 in memory', () => {
    expect(filterInMemory('priority:1e-7', rows).map(row => row.id)).toEqual([
      1
    ]);
    expect(
      filterInMemory('priority:in[1e-7, 2E3, -1.5e+2]', rows).map(row => row.id)
    ).toEqual([1, 2, 3]);
    expect(
      filterInMemory('priority:[1e-7 TO 1e3]', rows).map(row => row.id)
    ).toEqual([1, 4]);
  });

  it('returns the same ids for the list and the range on every engine', () => {
    for (const query of [
      'priority:[1e-7, 2E3, -1.5e+2]',
      'priority:in[1e-7, 2E3, -1.5e+2]',
      'priority:[1e-7 TO 1e3]',
      'priority:>2E3'
    ]) {
      const expected = filterInMemory(query, rows).map(row => row.id);
      expect(idsOfSql(parameterizedSql(query))).toEqual(expected);
      expect(idsOfSql(drizzleSql(query))).toEqual(expected);
    }
  });
});
