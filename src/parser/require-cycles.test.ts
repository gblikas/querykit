/**
 * No module of `src/parser` is in a require cycle.
 *
 * Under CommonJS a cycle is inert while every cross-module use sits inside
 * a function body, and breaks the moment a top-level statement reads the
 * other module's export before that module has finished running; nothing
 * else flags the change, since `eslint-plugin-import` is not a dependency.
 * So each module of this directory is loaded alone into a fresh module
 * registry, the source modules the registry then holds are its transitive
 * requires, and two modules that each hold the other are a cycle. The
 * graph is the one that runs: a type-only import is erased before a module
 * loads and leaves no require. `jest.isolateModules` is not used because
 * `require.cache` reads the main registry, which `jest.resetModules`
 * empties.
 */

import { readdirSync } from 'fs';
import path from 'path';

const PARSER_DIRECTORY = __dirname;
const SOURCE_DIRECTORY = path.resolve(__dirname, '..');

/** The modules of `src/parser` that are not tests, as absolute paths. */
function listParserModules(): string[] {
  return readdirSync(PARSER_DIRECTORY)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map(name => path.join(PARSER_DIRECTORY, name))
    .sort();
}

/** Whether `modulePath` is a module of this package's `src`. */
function isSourceModule(modulePath: string): boolean {
  return modulePath.startsWith(SOURCE_DIRECTORY + path.sep);
}

/**
 * Load `modulePath` alone into a fresh module registry and return the
 * other source modules it required, directly or through another module.
 */
function loadAlone(modulePath: string): Set<string> {
  jest.resetModules();
  require(modulePath);
  const loaded = Object.keys(require.cache).filter(isSourceModule);
  return new Set(loaded.filter(loadedPath => loadedPath !== modulePath));
}

const requiresOf = new Map<string, Set<string>>();

/** The transitive requires of `modulePath`, loaded once per module. */
function requiresOfModule(modulePath: string): Set<string> {
  const kept = requiresOf.get(modulePath);
  if (kept) {
    return kept;
  }
  const loaded = loadAlone(modulePath);
  requiresOf.set(modulePath, loaded);
  return loaded;
}

/** `modulePath` relative to `src`, for the test name and the diff. */
function nameOf(modulePath: string): string {
  return path.relative(SOURCE_DIRECTORY, modulePath);
}

describe('the parser modules', () => {
  const parserModules = listParserModules().map(modulePath => [
    nameOf(modulePath),
    modulePath
  ]);

  it('are found', () => {
    expect(parserModules.length).toBeGreaterThan(0);
  });

  it.each(parserModules)(
    '%s is in no require cycle',
    (_name: string, modulePath: string) => {
      const required = requiresOfModule(modulePath);
      const actualCyclePartners = [...required]
        .filter(other => requiresOfModule(other).has(modulePath))
        .map(nameOf)
        .sort();
      expect(actualCyclePartners).toEqual([]);
    }
  );
});
