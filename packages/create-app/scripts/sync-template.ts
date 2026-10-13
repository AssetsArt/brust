#!/usr/bin/env bun
// Generates templates/pokedex from examples/pokedex (M3-F R4/R5). Run at `prepack` (also on `bun publish`), by `create-app`
// itself in a brust checkout, and by the tests. The output is gitignored and must never be edited by hand.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PKG = resolve(import.meta.dir, '..')
const REPO = resolve(PKG, '../..')

/** Top-level names of examples/pokedex that are not part of a scaffold. */
const EXCLUDE_TOP = new Set(['dist', 'test', 'README.md', 'package.json', '.gitignore', '.wrangler'])

export interface SyncOpts {
  from?: string
  to?: string
  overlay?: string
}

function excluded(rel: string, top: boolean): boolean {
  const parts = rel.split('/')
  if (top && (EXCLUDE_TOP.has(parts[0]!) || /^dist-/.test(parts[0]!))) return true
  const name = parts[parts.length - 1]!
  return parts.includes('node_modules') || name === '.DS_Store' || name.endsWith('.tsbuildinfo') || /^data\/team\.sqlite/.test(rel) || /^\.dev\.vars/.test(name) || /\.sqlite(-wal|-shm)?$/.test(name)
}

/** The `wrangler` devDependency of the blank template: one source of truth for both scaffolds (M4-CF R6). */
function blankWrangler(): string {
  const file = join(PKG, 'templates/blank/package.json.tmpl')
  if (!existsSync(file)) throw new Error(`sync-template: ${file} not found (needed for the wrangler devDependency)`)
  const v = (JSON.parse(readFileSync(file, 'utf8').replace('__BRUST_DEP__', '"x"')) as { devDependencies?: Record<string, string> }).devDependencies?.wrangler
  if (!v) throw new Error('sync-template: templates/blank/package.json.tmpl has no devDependencies.wrangler')
  return v
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p, base) : e.isFile() ? [p.slice(base.length + 1)] : []
  })
}

export function syncTemplate(opts: SyncOpts = {}): { files: number } {
  const from = opts.from ?? join(REPO, 'examples/pokedex')
  const to = opts.to ?? join(PKG, 'templates/pokedex')
  const overlay = opts.overlay ?? join(PKG, 'template-overlays/pokedex')

  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  let files = 0
  for (const rel of walk(from)) {
    if (excluded(rel, true)) continue
    mkdirSync(dirname(join(to, rel)), { recursive: true })
    copyFileSync(join(from, rel), join(to, rel))
    files++
  }

  // package.json.tmpl: derived from the example (R6).
  const src = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8')) as {
    name?: string; version?: string; private?: boolean; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>
    [k: string]: unknown
  }
  if (src.dependencies?.['@brust/core'] !== 'workspace:*') {
    throw new Error(`sync-template: examples/pokedex must depend on @brust/core workspace:* (got ${src.dependencies?.['@brust/core']})`)
  }
  const { test: _test, ...scripts } = src.scripts ?? {}
  const pkg = { ...src, name: '__PROJECT_NAME__', version: '0.0.1', private: true, scripts: { dev: 'brust dev routes.tsx', ...scripts }, dependencies: { ...src.dependencies, '@brust/core': '__BRUST_DEP__' }, devDependencies: { ...src.devDependencies, wrangler: blankWrangler() } }
  writeFileSync(join(to, 'package.json.tmpl'), `${JSON.stringify(pkg, null, 2).replace('"__BRUST_DEP__"', '__BRUST_DEP__')}\n`)
  files++

  // _gitignore: the scaffold's ignores plus the example's own.
  const own = existsSync(join(from, '.gitignore')) ? readFileSync(join(from, '.gitignore'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : []
  writeFileSync(join(to, '_gitignore'), `${[...new Set(['node_modules/', 'dist/', ...own])].join('\n')}\n`)
  files++

  if (existsSync(overlay)) {
    cpSync(overlay, to, { recursive: true })
    files += walk(overlay).length
  }
  return { files }
}

if (import.meta.main) console.log(`[sync-template] templates/pokedex: ${syncTemplate().files} files`)
