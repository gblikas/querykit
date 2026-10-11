#!/bin/sh
# The demo depends on this repo via "file:../..". The library entry is
# dist/index.js, and dist/ is not committed. Vercel installs the demo and
# runs `pnpm run build` without compiling the parent, so Next cannot resolve
# "@gblikas/querykit". Compile this checkout before the Next build.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

cd "$ROOT"
# Vercel sets NODE_ENV=production for the build. Keep devDependencies so
# typescript is installed. Skip lifecycle scripts (the parent prepare script
# installs husky, which this preview does not need).
HUSKY=0 pnpm install --ignore-scripts --prod=false --frozen-lockfile
rm -rf dist
./node_modules/.bin/tsc --outDir dist

if [ ! -f "$ROOT/dist/index.js" ]; then
  echo "QueryKit build did not emit dist/index.js" >&2
  exit 1
fi

# pnpm hardlinks this file: dependency into the demo store at install time.
# dist/ does not exist yet during that install, so Next never sees the entry.
# Copy the build into the installed package unless it already points at this repo.
DEMO=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
if [ ! -e "$DEMO/node_modules/@gblikas/querykit" ]; then
  echo "Expected @gblikas/querykit to be installed in the demo." >&2
  exit 1
fi
INSTALLED_REAL=$(readlink -f "$DEMO/node_modules/@gblikas/querykit")
if [ "$INSTALLED_REAL" != "$ROOT" ]; then
  rm -rf "$INSTALLED_REAL/dist"
  cp -R "$ROOT/dist" "$INSTALLED_REAL/dist"
fi
node -e "require.resolve('@gblikas/querykit', { paths: ['$DEMO'] })" >/dev/null
