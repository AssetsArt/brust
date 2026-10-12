#!/usr/bin/env bun
// scripts/release-bump.ts — bump EVERY @brust/* version atomically, then VERIFY (0.1.x lesson: 0.1.54/0.1.57 shipped
// partial bumps). Refs: packages/brust, packages/runtime-dom, packages/create-app, npm/<6>. Dependencies between them are `workspace:*`
// (rewritten by `bun publish`), so there is nothing else to pin — the verify step enforces that invariant.
//   bun scripts/release-bump.ts 0.2.0-alpha.1            # bump + verify
//   bun scripts/release-bump.ts 0.2.0-alpha.1 --release  # + commit, tag v<version>, push (on v2 only)
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { $ } from 'bun'
import { FILES, PLATS } from './release-files'
const NEW = process.argv[2]; const RELEASE = process.argv.includes('--release')
if (!NEW || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(NEW)) { console.error('usage: bun scripts/release-bump.ts <version> [--release]'); process.exit(1) }
const ROOT = resolve(import.meta.dir, '..')
const EXPECTED = FILES.length // 9
function setVersion(text: string, v: string): { text: string; old: string | null } {
  const re = /("version"\s*:\s*")([^"]*)(")/; const m = text.match(re)
  return m ? { text: text.replace(re, `$1${v}$3`), old: m[2]! } : { text, old: null }
}
const changes: string[] = []
// Validate every file first so a failure writes nothing.
const staged = FILES.map((f) => {
  const r = setVersion(readFileSync(resolve(ROOT, f), 'utf8'), NEW)
  if (r.old === null) { console.error(`✗ ${f}: no "version" — aborting, nothing written`); process.exit(1) }
  return { f, r }
})
for (const { f, r } of staged) { writeFileSync(resolve(ROOT, f), r.text); if (r.old !== NEW) changes.push(`  ${f}: ${r.old} → ${NEW}`) }
let verified = 0; const problems: string[] = []
for (const f of FILES) { const j = JSON.parse(readFileSync(resolve(ROOT, f), 'utf8')); if (j.version === NEW) verified++; else problems.push(`  ${f}: ${j.version}`) }
const brust = JSON.parse(readFileSync(resolve(ROOT, 'packages/brust/package.json'), 'utf8'))
for (const [k, v] of Object.entries({ ...brust.dependencies, ...brust.optionalDependencies }) as [string, string][])
  if (k.startsWith('@brust/') && v !== 'workspace:*') problems.push(`  packages/brust ${k} is "${v}", must be workspace:* (bun publish rewrites it)`)
const want = PLATS.map((p) => `@brust/native-${p}`).sort().join(',')
if (Object.keys(brust.optionalDependencies ?? {}).sort().join(',') !== want) problems.push('  packages/brust optionalDependencies are not exactly the six @brust/native-* packages')
const createApp = JSON.parse(readFileSync(resolve(ROOT, 'packages/create-app/package.json'), 'utf8'))
if (Object.keys(createApp.dependencies ?? {}).some((k) => k.startsWith('@brust/'))) problems.push('  packages/create-app must not depend on @brust/*: its own version IS the @brust/core spec it writes (R3)')
if (brust.private || createApp.private || JSON.parse(readFileSync(resolve(ROOT, 'packages/runtime-dom/package.json'), 'utf8')).private) problems.push('  a package is still "private": true')
if (problems.length || verified !== EXPECTED) { console.error(`✗ verification FAILED (${verified}/${EXPECTED})`); for (const p of problems) console.error(p); process.exit(1) }
console.log(`✓ bumped ${verified}/${EXPECTED} refs to ${NEW}`); for (const c of changes) console.log(c)
if (!RELEASE) { console.log(`\nnext: git commit -am "chore(release): ${NEW}" && git tag -a v${NEW} -m "brust ${NEW}" && git push origin HEAD v${NEW}`); process.exit(0) }
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim()
if (branch !== 'v2') { console.error(`✗ --release refuses to run off v2 (on "${branch}")`); process.exit(1) }
await $`git add ${FILES}`; await $`git commit -m ${`chore(release): ${NEW}`}`; await $`git tag -a ${`v${NEW}`} -m ${`brust ${NEW}`}`
await $`git push origin HEAD`; await $`git push origin ${`v${NEW}`}`
console.log(`✓ pushed v${NEW} — release.yml publishes (human-confirmed by the tag)`)
