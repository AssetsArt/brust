#!/usr/bin/env bun
/**
 * scripts/release-bump.ts — atomically bump EVERY brustjs version reference, then
 * VERIFY, so a release can never ship a partial bump again.
 *
 * Why this exists: 0.1.54 and 0.1.57 both botched by bumping ONLY the root
 * package.json `version`. The 6 per-platform packages then can't publish (their
 * versions still pointed at the previous release), npm `latest` never moved onto
 * the new version, and brustjs' optionalDependencies pinned the wrong native
 * build. npm versions are immutable, so each botch cost a throwaway fix-forward
 * release (0.1.55, and now 0.1.58). This script makes the bump one foolproof
 * command.
 *
 * The 15 refs it owns:
 *   - package.json: `version`  +  6 `optionalDependencies["brustjs-*"]` pins
 *   - create-brustjs/package.json: `version`  +  `dependencies.brustjs`
 *   - npm/<6 targets>/package.json: `version`
 *
 * It tolerates a MIXED starting state (e.g. root already bumped, the rest not):
 * every ref is rewritten to the target regardless of its current value, and the
 * verify pass fails loudly if any ref is left behind or the count is wrong.
 *
 * Usage:
 *   bun scripts/release-bump.ts 0.1.58-alpha             # bump + verify only
 *   bun scripts/release-bump.ts 0.1.58-alpha --release   # + git commit, tag, push (triggers release.yml)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { $ } from 'bun'

const NEW = process.argv[2]
const RELEASE = process.argv.includes('--release')

if (!NEW || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(NEW)) {
  console.error('usage: bun scripts/release-bump.ts <new-version> [--release]')
  console.error('  e.g. bun scripts/release-bump.ts 0.1.58-alpha')
  process.exit(1)
}

const ROOT = resolve(import.meta.dir, '..')
const NPM_TARGETS = [
  'darwin-x64',
  'darwin-arm64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
]

/** Every (file, json key) pair that holds a brustjs version, with a human label. */
interface Ref {
  file: string
  key: string
  label: string
}
const REFS: Ref[] = [
  { file: 'package.json', key: 'version', label: 'brustjs version' },
  ...NPM_TARGETS.map((t) => ({
    file: 'package.json',
    key: `brustjs-${t}`,
    label: `optionalDependencies.brustjs-${t}`,
  })),
  { file: 'create-brustjs/package.json', key: 'version', label: 'create-brustjs version' },
  { file: 'create-brustjs/package.json', key: 'brustjs', label: 'create-brustjs → brustjs dep' },
  ...NPM_TARGETS.map((t) => ({
    file: `npm/${t}/package.json`,
    key: 'version',
    label: `npm/${t} version`,
  })),
]
const EXPECTED = REFS.length // 15

/** Replace the FIRST `"key": "<anything>"` value with `newVal`, preserving the
 * file's formatting (targeted text edit — NOT JSON.stringify, which would reflow
 * the whole file). Returns the previous value, or null if the key was absent. */
function setKey(text: string, key: string, newVal: string): { text: string; old: string | null } {
  const re = new RegExp(`("${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*")([^"]*)(")`)
  const m = text.match(re)
  if (!m) return { text, old: null }
  return { text: text.replace(re, `$1${newVal}$3`), old: m[2] }
}

// ── Apply ──────────────────────────────────────────────────────────────────
const byFile = new Map<string, Ref[]>()
for (const r of REFS) {
  const list = byFile.get(r.file)
  if (list) list.push(r)
  else byFile.set(r.file, [r])
}

const changes: string[] = []
for (const [file, refs] of byFile) {
  const abs = resolve(ROOT, file)
  let text = readFileSync(abs, 'utf8')
  for (const r of refs) {
    const res = setKey(text, r.key, NEW)
    if (res.old === null) {
      console.error(`✗ ${file}: key "${r.key}" not found (${r.label}) — aborting, nothing written`)
      process.exit(1)
    }
    text = res.text
    if (res.old !== NEW) changes.push(`  ${r.label}: ${res.old} → ${NEW}`)
  }
  writeFileSync(abs, text)
}

// ── Verify ─────────────────────────────────────────────────────────────────
// Re-read via JSON.parse (not the regex) so a malformed edit or a missed ref is
// caught independently of how the edit was made.
let verified = 0
const problems: string[] = []
const get = (obj: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
    obj,
  )

const pathOf = (r: Ref): string[] => {
  if (r.file === 'package.json' && r.key !== 'version') return ['optionalDependencies', r.key]
  if (r.file === 'create-brustjs/package.json' && r.key === 'brustjs')
    return ['dependencies', 'brustjs']
  return [r.key]
}

for (const [file, refs] of byFile) {
  const json = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'))
  for (const r of refs) {
    const val = get(json, pathOf(r))
    if (val === NEW) verified++
    else problems.push(`  ${file} ${r.label}: expected ${NEW}, got ${String(val)}`)
  }
}

if (problems.length > 0 || verified !== EXPECTED) {
  console.error(`✗ verification FAILED (${verified}/${EXPECTED} refs at ${NEW})`)
  for (const p of problems) console.error(p)
  process.exit(1)
}

console.log(`✓ bumped ${verified}/${EXPECTED} refs to ${NEW}`)
if (changes.length > 0) {
  console.log('changes:')
  for (const c of changes) console.log(c)
} else {
  console.log('(all refs were already at the target — no-op)')
}

// ── Optional release ─────────────────────────────────────────────────────────
if (!RELEASE) {
  console.log('\nnext (or re-run with --release):')
  console.log(`  git commit -am "chore(release): ${NEW}"`)
  console.log(`  git tag -a v${NEW} -m "brustjs ${NEW}"`)
  console.log(`  git push origin HEAD && git push origin v${NEW}`)
  process.exit(0)
}

const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim()
if (branch !== 'main') {
  console.error(`✗ --release refuses to run off main (on "${branch}"). Tag the merged main commit.`)
  process.exit(1)
}
console.log(`\nreleasing v${NEW} on main …`)
const files = [...byFile.keys()]
await $`git add ${files}`
await $`git commit -m ${`chore(release): ${NEW}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`}`
await $`git tag -a ${`v${NEW}`} -m ${`brustjs ${NEW}`}`
await $`git push origin HEAD`
await $`git push origin ${`v${NEW}`}`
console.log(`✓ pushed v${NEW} — release.yml will publish all ${EXPECTED} refs`)
