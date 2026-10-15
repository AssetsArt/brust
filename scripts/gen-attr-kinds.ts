// Generates packages/runtime-dom/src/attr-kinds.ts from the attribute tables in crates/brust-jinja/src/lib.rs
// (the compiler's `attr_kind` classifier), so the runtime and the server print booleans by one table.
// `bun scripts/gen-attr-kinds.ts` writes it; `--check` exits 1 when the file is stale (the runtime-dom test calls it).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const RS = join(root, 'crates/brust-jinja/src/lib.rs')
const OUT = join(root, 'packages/runtime-dom/src/attr-kinds.ts')

export function table(src: string, name: string): string[] {
  const m = src.match(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\];`))
  if (!m) throw new Error(`${name} not found in brust-jinja lib.rs`)
  return [...(m[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1] as string)
}

export function generate(): string {
  const src = readFileSync(RS, 'utf8')
  const line = (n: string, t: string) => `export const ${n} = set('${table(src, t).join(' ')}')`
  return `// GENERATED from crates/brust-jinja/src/lib.rs (BOOLEAN_ATTRS, OVERLOADED_ATTRS, STRINGIFY_ATTRS); do not edit.
// Regenerate: bun scripts/gen-attr-kinds.ts. test/attr-kinds.test.ts fails when this drifts.
const set = (s: string): Set<string> => new Set(s.split(' '))
${line('BOOLEAN', 'BOOLEAN_ATTRS')}
${line('OVERLOADED', 'OVERLOADED_ATTRS')}
${line('STRINGIFY', 'STRINGIFY_ATTRS')}
`
}

if (import.meta.main) {
  const next = generate()
  if (process.argv.includes('--check')) {
    if (readFileSync(OUT, 'utf8') !== next) { console.error('attr-kinds.ts is stale: run bun scripts/gen-attr-kinds.ts'); process.exit(1) }
  } else writeFileSync(OUT, next)
}
