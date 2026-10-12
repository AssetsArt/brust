#!/usr/bin/env bun
// scripts/release-check.ts — F88 lockstep guard: every published @brust/* package must carry <version>.
//   bun scripts/release-check.ts <version> [--root <dir>]
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FILES } from './release-files'
const args = process.argv.slice(2)
const ri = args.indexOf('--root')
const root = ri >= 0 ? resolve(args[ri + 1] ?? '') : resolve(import.meta.dir, '..')
const want = args.find((a, i) => !a.startsWith('--') && (ri < 0 || i !== ri + 1))
if (!want) { console.error('usage: bun scripts/release-check.ts <version> [--root <dir>]'); process.exit(1) }
let ok = 0
for (const f of FILES) {
  let got: string
  try { got = String(JSON.parse(readFileSync(resolve(root, f), 'utf8')).version) } catch (e) { console.error(`✗ ${f}: unreadable (${(e as Error).message})`); continue }
  if (got === want) ok++; else console.error(`✗ ${f}: ${got} (expected ${want})`)
}
// bun.lock carries the same versions and is what `bun publish` rewrites workspace:* from (absent in test fixture roots).
let lockBad = 0
if (existsSync(resolve(root, 'bun.lock'))) {
  const lockText = readFileSync(resolve(root, 'bun.lock'), 'utf8')
  for (const f of FILES) {
    const dir = f.replace(/\/package\.json$/, ''); const got = lockText.match(new RegExp(`"${dir}": \\{[^}]*?"version": "([^"]+)"`))?.[1] ?? 'missing'
    if (got !== want) { lockBad++; console.error(`✗ bun.lock ${dir}: ${got} (expected ${want}; run bun install)`) }
  }
}
if (ok !== FILES.length || lockBad) { console.error(`✗ lockstep FAILED (${ok}/${FILES.length})`); process.exit(1) }
console.log(`✓ ${ok}/${FILES.length} packages at ${want}`)
