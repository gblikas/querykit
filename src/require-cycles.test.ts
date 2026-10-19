/**
 * No module of `src` is in a require cycle.
 *
 * Under CommonJS a cycle is inert while every cross-module use sits inside
 * a function body, and breaks the moment a top-level statement reads the
 * other module's export before that module has finished running; nothing
 * else flags the change, since `eslint-plugin-import` is not a dependency.
 * So each non-test module under `src` is loaded alone into a fresh module
 * registry, the source modules the registry then holds are its transitive
 * requires, and two modules that each hold the other are a cycle. The
 * graph is the one that runs: a type-only import is erased before a module
 * loads and leaves no require. `jest.isolateModules` is not used because
 * `require.cache` reads the main registry, which `jest.resetModules`
 * empties.
 */

import { readdirSync } from 'fs';
import path from 'path';

const SOURCE_DIRECTORY = __dirname;

/** Whether a file name is a module of the package, not a test or a `.d.ts`. */
function isModuleName(name: string): boolean {
  return (
    name.endsWith('.ts') &&
    !name.endsWith('.test.ts') &&
    !name.endsWith('.spec.ts') &&
    !name.endsWith('.d.ts')
  );
}

/** The non-test modules under `directory`, as absolute paths. */
function listSourceModules(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== '__tests__') {
      found.push(...listSourceModules(entryPath));
    } else if (entry.isFile() && isModuleName(entry.name)) {
      found.push(entryPath);
    }
  }
  return found.sort();
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

describe('the source modules', () => {
  const sourceModules = listSourceModules(SOURCE_DIRECTORY).map(modulePath => [
    nameOf(modulePath),
    modulePath
  ]);

  it('are found, the root barrel among them', () => {
    expect(sourceModules.map(([name]) => name)).toContain('index.ts');
  });

  it.each(sourceModules)(
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
