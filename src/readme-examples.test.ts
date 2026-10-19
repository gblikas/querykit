/**
 * The README's TypeScript examples, compiled and run.
 *
 * Every fenced `ts` or `typescript` block of README.md is read when this
 * file runs. A block whose first line starts with `// fragment` is a piece
 * of a larger example and is skipped. Every other block is type-checked
 * with the TypeScript compiler API against the package's own types, with
 * `@gblikas/querykit` resolved to `src/index.ts`; a type error fails the
 * block and names the README line. A comment line `// name.ts` or
 * `// name.json` inside a block starts a file of that name, so the Quick
 * Start's `schema.ts` and `example.ts` are two modules and `./schema`
 * resolves between them.
 *
 * A block that states a result is also run. A result is a comment on or
 * right after a top-level expression statement, continued by the `//`
 * lines that directly follow it:
 *
 *   `// => <literal>`         the statement's value, awaited, equals the
 *                             literal; `...` inside an object or array
 *                             stands for entries the README does not show
 *   `// SQL: <text>`          the value is a raw SQL expression whose
 *                             PostgreSQL text is <text>
 *   `// throws <Name>: <msg>` the statement throws an error of that name
 *                             with that message
 *
 * The README leaves a few names to the reader ("db is your Drizzle
 * database"). They are declared below for the type check and supplied at
 * run time, `db` as a better-sqlite3 database holding the tables the
 * examples name and `ctx.currentUserId` as the `user123` the README prints.
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import ts from 'typescript';
import { SQL, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { PgDialect } from 'drizzle-orm/pg-core';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import * as querykit from './index';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const README_PATH = path.join(PROJECT_ROOT, 'README.md');
const PACKAGE_NAME = '@gblikas/querykit';
const SOURCE_ROOT = path.join(__dirname, 'index.ts');
/** Where the blocks live for the compiler; no such directory exists. */
const VIRTUAL_ROOT = path.join(__dirname, '__readme__');
const FRAGMENT_MARKER = /^\/\/ fragment\b/;
const FILE_HEADER = /^\/\/ ([\w-]+\.(?:ts|json))\s*$/;
const RESULT_MARKER = /^\s*\/\/\s*(?:=>|SQL:|throws\s)/;
const CHECK_FUNCTION = '__readmeCheck';

/**
 * The names README examples use without declaring them. Each is typed
 * loosely enough to accept the column names the examples invent, and
 * `schema` and `mySchema` carry the table keys the examples query.
 */
const PLACEHOLDER_TYPES = `
declare const db: unknown;
declare const users: Record<string, unknown>;
declare const tasks: Record<string, unknown>;
declare const products: Record<string, unknown>;
declare const schema: { my_table: Record<string, unknown> };
declare const mySchema: { items: Record<string, unknown> };
declare function getCurrentUserId(): Promise<string>;
declare function getUserTeamIds(): Promise<number[]>;
declare function getCurrentUser(): Promise<{
  id: number;
  teamIds: number[];
  tenantId: string;
}>;
declare function getUserTeams(userId: number): Promise<Array<{ id: number }>>;
declare const ctx: { currentUserId: string };
`;

const nodeRequire = createRequire(__filename);
/** Jest's own loader, so a block shares one copy of every module. */
const jestRequire: NodeRequire = require;

interface ISqliteDatabase {
  exec(sqlText: string): void;
  close(): void;
}

interface ISqliteDatabaseConstructor {
  new (filename: string): ISqliteDatabase;
}

interface IReadmeBlock {
  /** README line of the opening fence, 1-based. */
  line: number;
  lines: string[];
}

interface IExampleFile {
  name: string;
  /** README line of the file's first line, 1-based. */
  line: number;
  text: string;
}

interface IReadmeExample {
  line: number;
  files: IExampleFile[];
}

type ResultKind = 'value' | 'sql' | 'throws';

interface IStatedResult {
  kind: ResultKind;
  text: string;
  /** README line of the statement the result follows. */
  line: number;
  /** README line of the result comment itself. */
  markerLine: number;
}

type CheckFunction = (
  index: number,
  evaluate: () => Promise<unknown>
) => Promise<unknown>;

const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  name: text('name'),
  email: text('email'),
  status: text('status')
});

const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey(),
  title: text('title'),
  status: text('status'),
  priority: integer('priority'),
  assignee_id: integer('assignee_id'),
  creator_id: integer('creator_id'),
  owner_id: integer('owner_id'),
  watcher_ids: text('watcher_ids'),
  created_at: text('created_at')
});

const products = sqliteTable('products', {
  id: integer('id').primaryKey(),
  name: text('name'),
  description: text('description'),
  price: real('price'),
  category: text('category'),
  inStock: integer('in_stock', { mode: 'boolean' })
});

function openDatabase(): ISqliteDatabase {
  const Database = nodeRequire('better-sqlite3') as ISqliteDatabaseConstructor;
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, name TEXT, email TEXT, status TEXT
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY, title TEXT, status TEXT, priority INTEGER,
      assignee_id INTEGER, creator_id INTEGER, owner_id INTEGER,
      watcher_ids TEXT, created_at TEXT
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY, name TEXT, description TEXT, price REAL,
      category TEXT, in_stock INTEGER
    );
  `);
  return database;
}

/** Run-time values for the names PLACEHOLDER_TYPES declares. */
function createPlaceholders(
  database: ISqliteDatabase
): Record<string, unknown> {
  return {
    db: drizzle(database as never),
    users,
    tasks,
    products,
    schema: { my_table: tasks },
    mySchema: { items: tasks },
    getCurrentUserId: async (): Promise<string> => 'user123',
    getUserTeamIds: async (): Promise<number[]> => [1],
    getCurrentUser: async (): Promise<{
      id: number;
      teamIds: number[];
      tenantId: string;
    }> => ({ id: 1, teamIds: [1], tenantId: 'acme' }),
    getUserTeams: async (): Promise<Array<{ id: number }>> => [{ id: 1 }],
    ctx: { currentUserId: 'user123' }
  };
}

function readBlocks(markdown: string): IReadmeBlock[] {
  const lines = markdown.split('\n');
  const blocks: IReadmeBlock[] = [];
  let open: { language: string; line: number } | null = null;
  for (const [index, line] of lines.entries()) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (!fence) {
      continue;
    }
    if (open === null) {
      open = { language: fence[1], line: index + 1 };
      continue;
    }
    if (open.language === 'ts' || open.language === 'typescript') {
      blocks.push({ line: open.line, lines: lines.slice(open.line, index) });
    }
    open = null;
  }
  return blocks;
}

function isFragment(block: IReadmeBlock): boolean {
  const first = block.lines.find(line => line.trim() !== '');
  return first !== undefined && FRAGMENT_MARKER.test(first);
}

/** Split a block at its `// name.ts` headers; an unheaded block is one file. */
function splitFiles(block: IReadmeBlock): IExampleFile[] {
  const files: IExampleFile[] = [];
  let current: { name: string; line: number; lines: string[] } | null = null;
  for (const [index, line] of block.lines.entries()) {
    const header = FILE_HEADER.exec(line);
    const readmeLine = block.line + 1 + index;
    if (header) {
      if (current) {
        files.push({ ...current, text: current.lines.join('\n') });
      }
      // The header stays as a line so README line numbers hold; JSON
      // allows no comment, so there it becomes an empty line.
      const kept = header[1].endsWith('.json') ? '' : line;
      current = { name: header[1], line: readmeLine, lines: [kept] };
      continue;
    }
    if (!current) {
      if (line.trim() === '') {
        continue;
      }
      current = { name: 'example.ts', line: readmeLine, lines: [] };
    }
    current.lines.push(line);
  }
  if (current) {
    files.push({ ...current, text: current.lines.join('\n') });
  }
  return files;
}

function virtualPath(example: IReadmeExample, file: IExampleFile): string {
  return path.join(VIRTUAL_ROOT, `line-${example.line}`, file.name);
}

/** The package's strict settings, with top-level await allowed. */
const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  lib: ['lib.es2022.d.ts'],
  types: ['node'],
  esModuleInterop: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  noEmit: true,
  baseUrl: PROJECT_ROOT,
  paths: { [PACKAGE_NAME]: [path.relative(PROJECT_ROOT, SOURCE_ROOT)] }
};

/** The example files, each `.ts` forced into module scope, by path. */
function virtualSources(examples: IReadmeExample[]): Map<string, string> {
  const sources = new Map<string, string>();
  sources.set(path.join(VIRTUAL_ROOT, 'placeholders.d.ts'), PLACEHOLDER_TYPES);
  for (const example of examples) {
    for (const file of example.files) {
      const text = file.name.endsWith('.ts')
        ? `${file.text}\nexport {};\n`
        : file.text;
      sources.set(virtualPath(example, file), text);
    }
  }
  return sources;
}

/** A host that serves the virtual sources and the real disk for the rest. */
function createHost(sources: Map<string, string>): ts.CompilerHost {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const readFile = host.readFile;
  const fileExists = host.fileExists;
  const directoryExists = host.directoryExists ?? ((): boolean => false);
  host.getCurrentDirectory = (): string => PROJECT_ROOT;
  host.fileExists = (fileName): boolean =>
    sources.has(fileName) || fileExists(fileName);
  host.readFile = (fileName): string | undefined =>
    sources.get(fileName) ?? readFile(fileName);
  host.directoryExists = (directoryName): boolean =>
    directoryName.startsWith(VIRTUAL_ROOT) || directoryExists(directoryName);
  host.getSourceFile = (fileName, version): ts.SourceFile | undefined => {
    const source = sources.get(fileName) ?? readFile(fileName);
    return source === undefined
      ? undefined
      : ts.createSourceFile(fileName, source, version, true);
  };
  return host;
}

/** One program over every example. */
function createProgram(examples: IReadmeExample[]): ts.Program {
  const sources = virtualSources(examples);
  const rootNames = [...sources.keys()].filter(name => !name.endsWith('.json'));
  return ts.createProgram(rootNames, COMPILER_OPTIONS, createHost(sources));
}

/** Type errors of one example file, each prefixed with its README line. */
function typeErrors(
  program: ts.Program,
  example: IReadmeExample,
  file: IExampleFile
): string[] {
  const source = program.getSourceFile(virtualPath(example, file));
  if (!source) {
    return [`README.md:${file.line} ${file.name} is not in the program`];
  }
  return [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source)
  ].map(diagnostic => {
    const local =
      diagnostic.start === undefined
        ? 0
        : source.getLineAndCharacterOfPosition(diagnostic.start).line;
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      ' '
    );
    return `README.md:${file.line + local} TS${diagnostic.code} ${message}`;
  });
}

function readMarker(body: string): { kind: ResultKind; rest: string } | null {
  const trimmed = body.trim();
  if (trimmed.startsWith('=>')) {
    return { kind: 'value', rest: trimmed.slice(2) };
  }
  if (trimmed.startsWith('SQL:')) {
    return { kind: 'sql', rest: trimmed.slice(4) };
  }
  if (/^throws\s/.test(trimmed)) {
    return { kind: 'throws', rest: trimmed.slice(6) };
  }
  return null;
}

/** The result stated on or directly after a statement, if any. */
function readStatedResult(
  source: ts.SourceFile,
  statement: ts.Statement,
  firstLine: number
): IStatedResult | null {
  const text = source.text;
  const ranges = [
    ...(ts.getTrailingCommentRanges(text, statement.end) ?? []),
    ...(ts.getLeadingCommentRanges(text, statement.end) ?? [])
  ];
  const bodies: string[] = [];
  let previousLine = source.getLineAndCharacterOfPosition(statement.end).line;
  let markerLine = previousLine;
  for (const range of ranges) {
    const line = source.getLineAndCharacterOfPosition(range.pos).line;
    if (
      range.kind !== ts.SyntaxKind.SingleLineCommentTrivia ||
      line > previousLine + 1
    ) {
      break;
    }
    if (bodies.length === 0) {
      markerLine = line;
    }
    bodies.push(text.slice(range.pos + 2, range.end));
    previousLine = line;
  }
  const marker = bodies.length > 0 ? readMarker(bodies[0]) : null;
  if (!marker) {
    return null;
  }
  const statementLine = source.getLineAndCharacterOfPosition(
    statement.getStart(source)
  ).line;
  const rest = bodies.slice(1);
  const stated =
    marker.kind === 'value'
      ? [marker.rest, ...rest].join('\n')
      : [marker.rest, ...rest].map(body => body.trim()).join(' ');
  return {
    kind: marker.kind,
    text: stated.trim(),
    line: firstLine + statementLine,
    markerLine: firstLine + markerLine
  };
}

/** A top-level expression statement with the result it states. */
interface ICheckedStatement {
  expression: ts.Expression;
  stated: IStatedResult;
}

/**
 * The statements of a file that state a result.
 *
 * @throws {Error} When a result comment follows no top-level expression
 */
function checkedStatements(file: IExampleFile): ICheckedStatement[] {
  const source = ts.createSourceFile(
    file.name,
    file.text,
    ts.ScriptTarget.ES2022,
    true
  );
  const checked: ICheckedStatement[] = [];
  for (const statement of source.statements) {
    const stated = readStatedResult(source, statement, file.line);
    if (!stated) {
      continue;
    }
    if (!ts.isExpressionStatement(statement)) {
      throw new Error(
        `README.md:${stated.line}: a result must follow an expression statement`
      );
    }
    checked.push({ expression: statement.expression, stated });
  }
  const attached = new Set(checked.map(entry => entry.stated.markerLine));
  const unattached = file.text
    .split('\n')
    .map((line, index) => (RESULT_MARKER.test(line) ? file.line + index : -1))
    .filter(line => line >= 0 && !attached.has(line));
  if (unattached.length > 0) {
    const lines = unattached.join(', ');
    throw new Error(
      `README.md:${lines}: a result comment must follow a top-level statement`
    );
  }
  return checked;
}

/** Rewrite each checked statement into a call that checks it, in order. */
function instrument(file: IExampleFile, checked: ICheckedStatement[]): string {
  let code = file.text;
  [...checked].reverse().forEach(({ expression }, reversedIndex) => {
    const index = checked.length - 1 - reversedIndex;
    const start = expression.getStart();
    const text = code.slice(start, expression.end);
    const call = `await ${CHECK_FUNCTION}(${index}, async () => (${text}))`;
    code = code.slice(0, start) + call + code.slice(expression.end);
  });
  return code;
}

const ELISION = Symbol('entries the README does not show');
/** Spread into an object it marks the object; into an array, an entry. */
const ELIDED: Record<symbol, unknown> = Object.defineProperty(
  { [ELISION]: true },
  Symbol.iterator,
  { value: (): Iterator<symbol> => [ELISION][Symbol.iterator]() }
);

/** Turn each bare `...` outside a string into a spread of ELIDED. */
function spellElisions(literal: string): string {
  let spelled = '';
  let quote: string | null = null;
  for (let index = 0; index < literal.length; index++) {
    const character = literal[index];
    if (quote !== null) {
      spelled += character;
      if (character === '\\') {
        spelled += literal[++index] ?? '';
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      spelled += character;
      continue;
    }
    if (
      literal.startsWith('...', index) &&
      !/[\w$.]/.test(literal[index + 3] ?? '')
    ) {
      spelled += '...ELIDED';
      index += 2;
      continue;
    }
    spelled += character;
  }
  return spelled;
}

/** Replace each elided object or array with a matcher for what is shown. */
function withElisions(value: unknown): unknown {
  if (Array.isArray(value)) {
    const shown = value.filter(entry => entry !== ELISION).map(withElisions);
    return shown.length === value.length
      ? shown
      : expect.arrayContaining(shown);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string | symbol, unknown>;
    const shown: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      shown[key] = withElisions(record[key]);
    }
    return ELISION in record ? expect.objectContaining(shown) : shown;
  }
  return value;
}

function parseStatedValue(stated: IStatedResult): unknown {
  const evaluate = new Function(
    'ELIDED',
    `return (${spellElisions(stated.text)});`
  ) as (elided: unknown) => unknown;
  try {
    return withElisions(evaluate(ELIDED));
  } catch (error) {
    throw new Error(
      `README.md:${stated.line}: the result is not a literal: ${String(error)}`
    );
  }
}

/** Prefix a failed assertion with the README line it concerns. */
function expectAt(line: number, assertion: () => void): void {
  try {
    assertion();
  } catch (failure) {
    if (failure instanceof Error) {
      failure.message = `README.md:${line}\n${failure.message}`;
    }
    throw failure;
  }
}

function renderSql(stated: IStatedResult, value: unknown): string {
  const raw = (value ?? {}) as { type?: unknown; toSql?: unknown };
  const rendered =
    raw.type === 'raw' && typeof raw.toSql === 'function'
      ? raw.toSql({ adapter: 'drizzle', tableName: '', schema: {} })
      : value;
  if (!is(rendered, SQL)) {
    throw new Error(
      `README.md:${stated.line}: the statement is not a raw SQL expression`
    );
  }
  return new PgDialect().sqlToQuery(rendered).sql;
}

function assertThrown(
  stated: IStatedResult,
  threw: boolean,
  error: unknown
): void {
  const separator = stated.text.indexOf(':');
  const name = separator < 0 ? stated.text : stated.text.slice(0, separator);
  const message =
    separator < 0 ? null : stated.text.slice(separator + 1).trim();
  const thrown = error as { name?: unknown; message?: unknown } | undefined;
  expectAt(stated.line, (): void => {
    expect(threw ? `throws ${String(thrown?.name)}` : 'returns').toBe(
      `throws ${name.trim()}`
    );
    if (message !== null) {
      expect(thrown?.message).toBe(message);
    }
  });
}

function createChecker(results: IStatedResult[]): CheckFunction {
  return async (index, evaluate): Promise<unknown> => {
    const stated = results[index];
    let value: unknown;
    let error: unknown;
    let threw = false;
    try {
      value = await evaluate();
    } catch (caught) {
      error = caught;
      threw = true;
    }
    if (stated.kind === 'throws') {
      assertThrown(stated, threw, error);
      return undefined;
    }
    if (threw) {
      throw new Error(`README.md:${stated.line}: ${String(error)}`);
    }
    if (stated.kind === 'sql') {
      expectAt(stated.line, (): void => {
        expect(renderSql(stated, value)).toBe(stated.text);
      });
    } else {
      const expected = parseStatedValue(stated);
      expectAt(stated.line, (): void => {
        expect(value).toEqual(expected);
      });
    }
    return value;
  };
}

/**
 * A `require` for a block: the package is `src/index.ts`, `./name` is a
 * file of the block listed earlier, anything else is a dependency.
 */
function createBlockRequire(
  example: IReadmeExample,
  loaded: Map<string, unknown>
): (specifier: string) => unknown {
  return (specifier: string): unknown => {
    if (specifier === PACKAGE_NAME) {
      return querykit;
    }
    if (!specifier.startsWith('./')) {
      return jestRequire(specifier);
    }
    const name = specifier.slice(2);
    const sibling = example.files.find(
      file => file.name === name || file.name === `${name}.ts`
    );
    if (sibling?.name.endsWith('.json')) {
      return JSON.parse(sibling.text);
    }
    if (!sibling || !loaded.has(sibling.name)) {
      throw new Error(
        `README.md:${example.line}: ${specifier} is no earlier block file`
      );
    }
    return loaded.get(sibling.name);
  };
}

/** CommonJS for one instrumented file; top-level await is kept. */
function transpile(file: IExampleFile, code: string): string {
  const output = ts.transpileModule(code, {
    fileName: file.name,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    }
  });
  const [first] = output.diagnostics ?? [];
  if (first) {
    const message = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    throw new Error(`README.md:${file.line}: ${message}`);
  }
  return output.outputText;
}

/** Run one file as an async CommonJS module and return its exports. */
async function runFile(
  file: IExampleFile,
  blockRequire: (specifier: string) => unknown,
  placeholders: Record<string, unknown>
): Promise<unknown> {
  const checked = checkedStatements(file);
  const code = transpile(file, instrument(file, checked));
  const module = { exports: {} as Record<string, unknown> };
  const names = Object.keys(placeholders);
  const run = new Function(
    'require',
    'module',
    'exports',
    CHECK_FUNCTION,
    ...names,
    `return (async () => {\n${code}\n})();`
  ) as (...args: unknown[]) => Promise<void>;
  await run(
    blockRequire,
    module,
    module.exports,
    createChecker(checked.map(entry => entry.stated)),
    ...names.map(name => placeholders[name])
  );
  return module.exports;
}

/** Run the `.ts` files of an example in order. */
async function runExample(
  example: IReadmeExample,
  placeholders: Record<string, unknown>
): Promise<void> {
  const loaded = new Map<string, unknown>();
  const blockRequire = createBlockRequire(example, loaded);
  for (const file of example.files) {
    if (file.name.endsWith('.ts')) {
      loaded.set(file.name, await runFile(file, blockRequire, placeholders));
    }
  }
}

function statesResults(example: IReadmeExample): boolean {
  return example.files.some(
    file =>
      file.name.endsWith('.ts') &&
      file.text.split('\n').some(line => RESULT_MARKER.test(line))
  );
}

const blocks = readBlocks(readFileSync(README_PATH, 'utf8'));
const examples: IReadmeExample[] = blocks
  .filter(block => !isFragment(block))
  .map(block => ({ line: block.line, files: splitFiles(block) }));

describe('README examples', () => {
  let program: ts.Program;
  let database: ISqliteDatabase;
  let placeholders: Record<string, unknown>;

  beforeAll((): void => {
    program = createProgram(examples);
    database = openDatabase();
    placeholders = createPlaceholders(database);
  });

  afterAll((): void => {
    database.close();
  });

  it('finds TypeScript blocks and compiles them in one sound program', () => {
    expect(blocks.length).toBeGreaterThan(0);
    expect(examples.length).toBeGreaterThan(0);
    const global = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics()
    ].map(diagnostic =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
    );
    expect(global).toEqual([]);
  });

  describe.each(
    examples.map((example): [number, IReadmeExample] => [example.line, example])
  )('README.md:%i', (_line: number, example: IReadmeExample) => {
    it('type-checks against the package types', () => {
      const errors = example.files.some(file => file.name.endsWith('.ts'))
        ? example.files.flatMap(file => typeErrors(program, example, file))
        : [`README.md:${example.line} the block has no TypeScript file`];
      expect(errors).toEqual([]);
    });

    if (statesResults(example)) {
      it('states results that hold when run', async () => {
        await runExample(example, placeholders);
      });
    }
  });
});
