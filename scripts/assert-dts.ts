// Gate for `bun run build:dts`.
//
// `tsc -p tsconfig.dts.json` runs with noEmitOnError:false — a handful of
// pre-existing (non-strict) type errors are tolerated and declarations are
// emitted anyway, so tsc's own exit code is NOT the signal (it would fail
// prepack on errors that don't block emit). THIS script is the gate: every
// declaration file the package.json exports map points at must exist, or the
// pack/publish must fail loudly.
//
// Run from repo root: bun scripts/assert-dts.ts

import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Must mirror the `types` condition of every subpath in package.json#exports.
const REQUIRED = [
  'types/index.d.ts',
  'types/routes.d.ts',
  'types/client/index.d.ts',
  'types/create.d.ts',
  'types/store/index.d.ts',
  'types/native/index.d.ts',
  'types/navigation/index.d.ts',
]

const root = join(import.meta.dir, '..')
const missing = REQUIRED.filter((rel) => !existsSync(join(root, rel)))

if (missing.length > 0) {
  console.error('build:dts did not produce the exports-map declaration files:')
  for (const rel of missing) console.error(`  missing: ${rel}`)
  process.exit(1)
}

// Cross-check against package.json so the list above can't silently drift
// from the real exports map.
const pkg = await Bun.file(join(root, 'package.json')).json()
for (const [subpath, target] of Object.entries(pkg.exports as Record<string, unknown>)) {
  const types = (target as Record<string, string>)?.types
  if (!types) {
    console.error(`exports["${subpath}"] has no "types" condition`)
    process.exit(1)
  }
  const rel = types.replace(/^\.\//, '')
  if (!REQUIRED.includes(rel)) {
    console.error(`exports["${subpath}"].types = ${types} is not covered by assert-dts.ts`)
    process.exit(1)
  }
  if (!existsSync(join(root, rel))) {
    console.error(`exports["${subpath}"].types = ${types} does not exist on disk`)
    process.exit(1)
  }
}

console.log(`build:dts ok — ${REQUIRED.length} exports-map declaration entrypoints present`)
