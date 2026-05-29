import { relative } from 'node:path'
import type { ActionDef, ActionFn } from './actions.ts'
import { isValidActionId, getActionMiddleware } from './actions.ts'

const DIRECTIVE_HEAD_BYTES = 512

/** Remove leading whitespace, line comments (`//`), and block comments
 * from `src` and return the rest. Stops at the first non-trivial character.
 * Does NOT understand string literals — fine because we only run this on a
 * directive prologue, which by spec contains comments and the directive only.
 * If a block comment never terminates, returns '' so the caller treats the
 * file as non-server. */
export function stripLeadingTrivia(src: string): string {
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      if (nl === -1) return ''
      i = nl + 1
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) return ''
      i = end + 2
      continue
    }
    break
  }
  return src.slice(i)
}

const USE_SERVER_PATTERN = /^(?:'use server'|"use server")\s*;?\s*(?:\r?\n|$)/

/** Read the first 512 bytes of `filePath` and return true iff a file-level
 * `'use server'` directive sits at the prologue position (before any import
 * or other statement). Comments and whitespace ahead of the directive are
 * skipped. Mirrors the TC39 directive-prologue rule. */
export async function hasUseServerDirective(filePath: string): Promise<boolean> {
  const f = Bun.file(filePath)
  const head = await f.slice(0, DIRECTIVE_HEAD_BYTES).text()
  const stripped = stripLeadingTrivia(head)
  return USE_SERVER_PATTERN.test(stripped)
}

/** Dynamically import `filePath` and collect every named function export as
 * an ActionDef. Skips non-function exports silently. Throws on:
 *   - default export (must be named)
 *   - class export (calling a class without `new` would 500 at dispatch)
 *   - invalid id charset
 *   - zero function exports (likely a bug — file marked 'use server' but
 *     publishes nothing).
 * Middleware metadata installed by withMiddleware is preserved. */
export async function collectExports(filePath: string): Promise<ActionDef[]> {
  const mod = (await import(filePath)) as Record<string, unknown>
  const defs: ActionDef[] = []
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'function') continue
    // typeof class{} is 'function' in JS; reject explicitly so an accidental
    // `export class Foo {}` in a 'use server' file fails loudly at scan,
    // not with a confusing 500 at dispatch.
    if (Function.prototype.toString.call(value).startsWith('class ')) {
      throw new Error(
        `${filePath}: export "${name}" is a class. Actions must be plain async functions, not class constructors.`,
      )
    }
    if (name === 'default') {
      throw new Error(`${filePath}: default exports are not action-eligible. Use named export.`)
    }
    if (!isValidActionId(name)) {
      throw new Error(
        `${filePath}: export "${name}" has invalid id (must match [A-Za-z0-9_-]+, 1-128 chars).`,
      )
    }
    defs.push({
      id: name,
      fn: value as ActionFn,
      middleware: getActionMiddleware(value),
    })
  }
  if (defs.length === 0) {
    throw new Error(`${filePath}: marked 'use server' but exports no functions.`)
  }
  return defs
}

export interface ScanOptions {
  /** Glob roots to scan from. Default: ['./']. Pass an explicit root (e.g.
   * `import.meta.dirname`) when the project layout includes sibling subtrees
   * you don't want scanned — typical for example apps inside a larger repo. */
  roots?: string[]
  /** Ignore globs (matched against the path relative to each root). Override
   * the default array if you need a different policy — there's no merge.
   * Default covers build outputs and test patterns. */
  ignore?: string[]
}

const DEFAULT_IGNORE = Object.freeze([
  'node_modules/**',
  '.brust/**',
  'dist/**',
  'build/**',
  'tests/**',
  '__tests__/**',
  '*.test.ts',
  '*.test.tsx',
  '*.spec.ts',
  '*.spec.tsx',
])

const FILE_PATTERN = '**/*.{ts,tsx,js,jsx,mjs,cjs}'

async function findCandidateFiles(opts: ScanOptions): Promise<string[]> {
  const roots = opts.roots ?? ['./']
  const ignore = opts.ignore ?? [...DEFAULT_IGNORE]
  const ignoreGlobs = ignore.map((p) => new Bun.Glob(p))
  const out: string[] = []
  for (const root of roots) {
    const glob = new Bun.Glob(FILE_PATTERN)
    for await (const f of glob.scan({ cwd: root, dot: false, absolute: true })) {
      const rel = relative(root, f)
      if (ignoreGlobs.some((g) => g.match(rel))) continue
      out.push(f)
    }
  }
  return out
}

export interface ScanActionsResult {
  actions: ActionDef[]
  /** Absolute paths of files that had a `'use server'` directive — needed by
   * `brust.buildMcpManifest` to feed the TypeScript compiler API extractor. */
  sourceFiles: string[]
}

/** Walk the project, find files whose first statement is `'use server'`,
 * import each, and return all named function exports as ActionDef[] plus the
 * list of server source files.
 * Throws on duplicate ids across files. Always returns actions sorted by id
 * for deterministic logging. */
export async function scanActions(opts: ScanOptions = {}): Promise<ScanActionsResult> {
  const candidates = await findCandidateFiles(opts)
  // Run directive checks in parallel — file IO scales well there.
  const directiveChecks = await Promise.all(
    candidates.map(async (p) => ({ path: p, isServer: await hasUseServerDirective(p) })),
  )
  const serverFiles = directiveChecks.filter((c) => c.isServer).map((c) => c.path)

  // Serial imports — heavy module side effects shouldn't all fire at once.
  const byId = new Map<string, string>()
  const all: ActionDef[] = []
  for (const file of serverFiles) {
    const defs = await collectExports(file)
    for (const def of defs) {
      const prior = byId.get(def.id)
      if (prior) {
        throw new Error(
          `Duplicate action "${def.id}" — defined in both ${prior} and ${file}. Rename one.`,
        )
      }
      byId.set(def.id, file)
      all.push(def)
    }
  }
  all.sort((a, b) => a.id.localeCompare(b.id))
  return { actions: all, sourceFiles: serverFiles }
}
