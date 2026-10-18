/**
 * Resolution of a field name against a schema by ASCII case, the rule
 * SQLite applies to an identifier and both adapters apply when they resolve
 * a field to a column. `createQueryKit` uses it to respell a folded name as
 * the schema property, to check a sort key, and to respell its field lists
 * under `caseInsensitiveFields`; the `parseWithContext` allowlist pre-check
 * folds with the same function.
 */

import { readFieldIdentifiers } from '../translators/field-identifiers';
import { foldAsciiCase } from '../translators/own-key-case';
import { DeniedValue, ISecurityOptions } from './types';

export { foldAsciiCase };

/**
 * A schema as the kit holds it: tables keyed by name, each declaring its
 * properties as own keys. A Drizzle table and a plain object both qualify.
 */
export type SchemaTables = Record<string, Record<string, unknown>>;

/** The outcome of matching a name against candidates by ASCII case. */
interface ICaseMatch {
  /** The exact candidate, else the one candidate differing only by case. */
  key?: string;
  /** True when two or more candidates fold alike and none is exact. */
  isAmbiguous: boolean;
}

/**
 * Match a name against candidates: the exact candidate wins, else the single
 * candidate whose `A-Z` fold matches the name's.
 */
function matchAsciiCase(
  candidates: readonly string[],
  name: string
): ICaseMatch {
  if (candidates.includes(name)) {
    return { key: name, isAmbiguous: false };
  }
  const folded = foldAsciiCase(name);
  const matches = candidates.filter(
    candidate => foldAsciiCase(candidate) === folded
  );
  if (matches.length === 1) {
    return { key: matches[0], isAmbiguous: false };
  }
  return { isAmbiguous: matches.length > 1 };
}

/** The own property names of one table; anything but an object declares none. */
function tablePropertyNames(table: unknown): string[] {
  return typeof table === 'object' && table !== null ? Object.keys(table) : [];
}

/** Every property name any table of the schema declares, each once. */
function schemaPropertyNames(schema: SchemaTables): string[] {
  const names = new Set<string>();
  for (const table of Object.keys(schema)) {
    for (const name of tablePropertyNames(schema[table])) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * Resolve a field name to the schema's spelling. An exact property key of
 * any table wins; otherwise the single property whose `A-Z` fold matches is
 * returned. A name with one unmarked dot that is no property is
 * `table.column`: the table part is resolved among the schema's table keys
 * and the column part among that table's properties by the same rule, and
 * the pair is returned in the schema's spelling. A name the schema declares
 * nothing for is returned as written, so an allowlist can reject it; only
 * own string keys are read, so a prototype name such as `constructor` is
 * never a property.
 *
 * @param schema - Tables keyed by name
 * @param name - The field as the parser resolved it
 * @param isLiteral - True when the parser marked the name literal, so its
 * dot is part of the name and never a qualifier
 * @returns The schema spelling, the name as written when it names nothing,
 * or undefined when it folds onto two properties or two tables
 *
 * @example
 * ```typescript
 * resolveSchemaFieldCase({ items: { createdAt: 1 } }, 'createdat'); // 'createdAt'
 * resolveSchemaFieldCase({ items: { createdAt: 1 } }, 'ITEMS.CreatedAt'); // 'items.createdAt'
 * resolveSchemaFieldCase({ items: { createdAt: 1 } }, 'nope'); // 'nope'
 * resolveSchemaFieldCase({ notes: { createdAt: 1, CreatedAt: 2 } }, 'createdat'); // undefined
 * ```
 */
export function resolveSchemaFieldCase(
  schema: SchemaTables,
  name: string,
  isLiteral = false
): string | undefined {
  const property = matchAsciiCase(schemaPropertyNames(schema), name);
  if (property.key !== undefined) {
    return property.key;
  }
  if (property.isAmbiguous) {
    return undefined;
  }
  const parts = readFieldIdentifiers(name, isLiteral);
  if (parts.length !== 2) {
    return name;
  }
  const table = matchAsciiCase(Object.keys(schema), parts[0]);
  if (table.key === undefined) {
    return table.isAmbiguous ? undefined : name;
  }
  const column = matchAsciiCase(
    tablePropertyNames(schema[table.key]),
    parts[1]
  );
  if (column.key === undefined) {
    return column.isAmbiguous ? undefined : name;
  }
  return `${table.key}.${column.key}`;
}

/** Each name once, in first-seen order. */
function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/** The union of two value lists, each value once, in first-seen order. */
function uniteValues(
  existing: readonly DeniedValue[],
  values: readonly DeniedValue[]
): DeniedValue[] {
  const united = [...existing];
  for (const value of values) {
    if (!united.includes(value)) {
      united.push(value);
    }
  }
  return united;
}

/**
 * Respell the keys of a value map; two keys that respell alike carry the
 * union of their values.
 */
function respellValueKeys(
  valuesByKey: Record<string, DeniedValue[]>,
  respell: (name: string) => string
): Record<string, DeniedValue[]> {
  const respelled: Record<string, DeniedValue[]> = {};
  for (const key of Object.keys(valuesByKey)) {
    const name = respell(key);
    respelled[name] = uniteValues(respelled[name] ?? [], valuesByKey[key]);
  }
  return respelled;
}

/**
 * Respell `allowedFields`, `denyFields` and the keys of `denyValues` as the
 * schema declares them, under `caseInsensitiveFields` only. The parser
 * folds every query field before the lists are compared, and the kit
 * respells the folded field as the schema property, so a list entry in any
 * ASCII case has to land on the same spelling. An entry that names no
 * property, or that folds onto two, is kept as written. Without the option
 * the options are returned as given.
 *
 * @param options - The resolved security options
 * @param schema - Tables keyed by name
 * @param foldsCase - The parser's `caseInsensitiveFields`
 * @returns The options with the lists respelled
 *
 * @example
 * ```typescript
 * canonicalizeSecurityFields(
 *   { ...DEFAULT_SECURITY_OPTIONS, allowedFields: ['createdat', 'id'] },
 *   { items: { id: 1, createdAt: 1 } },
 *   true
 * ).allowedFields; // ['createdAt', 'id']
 * ```
 */
export function canonicalizeSecurityFields(
  options: Required<ISecurityOptions>,
  schema: SchemaTables,
  foldsCase: boolean
): Required<ISecurityOptions> {
  if (!foldsCase) {
    return options;
  }
  const respell = (name: string): string =>
    resolveSchemaFieldCase(schema, name) ?? name;
  return {
    ...options,
    allowedFields: uniqueNames(options.allowedFields.map(respell)),
    denyFields: uniqueNames(options.denyFields.map(respell)),
    denyValues: respellValueKeys(options.denyValues, respell)
  };
}
