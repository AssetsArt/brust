# `"use server"` Directive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual `brust.registerActions([...])` API with a boot-time scanner that finds `'use server'` files, dynamically imports them, and auto-registers all exported functions as server actions.

**Architecture:** A new module `runtime/scan-actions.ts` walks the project from configurable `roots` via `Bun.Glob`, reads the first ~512 bytes of each candidate file to detect the file-level directive, dynamically imports matching files, and collects named function exports as `ActionDef[]`. Per-action middleware attaches via a new `withMiddleware([...], fn)` wrapper that stashes metadata on the function. Both main and workers call `await brust.scanActions()` at boot. `brust.serve` accepts the resulting `ActionDef[]` and registers ids with Rust internally.

**Tech Stack:** TypeScript, Bun 1.4 runtime, Bun.Glob for filesystem walk, `bun:test` for unit + integration tests. No Rust changes.

**Spec:** `docs/superpowers/specs/2026-05-24-use-server-directive-design.md`

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `runtime/actions.ts` | Modify | Add `withMiddleware` wrapper + `getActionMiddleware` reader |
| `runtime/actions.test.ts` | Create | Unit tests for `withMiddleware` |
| `runtime/scan-actions.ts` | Create | `stripLeadingTrivia`, `hasUseServerDirective`, `collectExports`, `findCandidateFiles`, `scanActions` |
| `runtime/scan-actions.test.ts` | Create | Unit tests for the scanner using temp-dir fixtures |
| `runtime/index.ts` | Modify | Add `brust.scanActions`, accept `actions` in `brust.serve`, drop public `defineActions` / `brust.registerActions` |
| `example/hello-world/actions.ts` | Modify | Add `'use server'` directive + use `withMiddleware` for `deleteNote` |
| `example/hello-world/index.ts` | Modify | Replace manual registration with `await brust.scanActions(...)` |
| `tests/integration.test.ts` | Verify | Existing 30 tests still pass; no new tests needed (migration is invisible to existing assertions) |
| `architecture.md` | Modify | Promote `"use server"` directive from "Designed not built" to "Built" |

---

## Task 1: `withMiddleware` helper + `getActionMiddleware` reader

**Files:**
- Modify: `runtime/actions.ts`
- Create: `runtime/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `runtime/actions.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { withMiddleware, getActionMiddleware, isValidActionId } from './actions.ts'
import type { Middleware } from './routes.ts'

const mwA: Middleware = async (_req, next) => next()
const mwB: Middleware = async (_req, next) => next()

test('withMiddleware returns the same function reference', () => {
  const fn = async (_req: unknown) => 'ok'
  const wrapped = withMiddleware([mwA], fn)
  expect(wrapped).toBe(fn)
})

test('withMiddleware stores the middleware array on the fn', () => {
  const fn = async (_req: unknown) => 'ok'
  withMiddleware([mwA, mwB], fn)
  expect(getActionMiddleware(fn)).toEqual([mwA, mwB])
})

test('getActionMiddleware returns undefined for unwrapped fns', () => {
  const fn = async (_req: unknown) => 'ok'
  expect(getActionMiddleware(fn)).toBeUndefined()
})

test('withMiddleware rejects non-array mws', () => {
  const fn = async (_req: unknown) => 'ok'
  expect(() => withMiddleware('nope' as any, fn)).toThrow(TypeError)
})

test('withMiddleware rejects mws containing non-functions', () => {
  const fn = async (_req: unknown) => 'ok'
  expect(() => withMiddleware([mwA, 'nope' as any], fn)).toThrow(TypeError)
})

test('withMiddleware rejects double-wrap with a clear message', () => {
  const fn = async (_req: unknown) => 'ok'
  withMiddleware([mwA], fn)
  expect(() => withMiddleware([mwB], fn)).toThrow(/called twice/)
})

test('withMiddleware result freezes the middleware array', () => {
  const fn = async (_req: unknown) => 'ok'
  const mws = [mwA]
  withMiddleware(mws, fn)
  const stored = getActionMiddleware(fn)!
  expect(Object.isFrozen(stored)).toBe(true)
  // Mutating the input does NOT affect the stored copy.
  mws.push(mwB)
  expect(getActionMiddleware(fn)).toHaveLength(1)
})

test('isValidActionId stays unchanged', () => {
  // sanity: this test guards against accidental edits to the charset helper
  expect(isValidActionId('createNote')).toBe(true)
  expect(isValidActionId('a.b')).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd runtime && bun test actions.test.ts 2>&1 | tail -10`

Expected: FAIL with `withMiddleware` / `getActionMiddleware` not defined.

- [ ] **Step 3: Implement the helpers**

Append to `runtime/actions.ts` (after the `isValidActionId` export):

```ts
const BRUST_MW_KEY = '__brustMiddleware'

/** Attach a middleware chain to a server-action function. The function is
 * returned unchanged so the TypeScript signature is preserved verbatim —
 * callers can still write `typeof srv.deleteNote` on the client.
 *
 * Throws TypeError if `mws` isn't an array of functions.
 * Throws Error if called twice on the same fn (compose mws in one call).
 */
export function withMiddleware<F extends (...args: never[]) => unknown>(
  mws: readonly Middleware[],
  fn: F,
): F {
  if (!Array.isArray(mws) || mws.some((m) => typeof m !== 'function')) {
    throw new TypeError('withMiddleware expects an array of middleware functions')
  }
  if ((fn as { [BRUST_MW_KEY]?: unknown })[BRUST_MW_KEY] !== undefined) {
    throw new Error(
      'withMiddleware called twice on the same function — compose middleware in a single call instead',
    )
  }
  Object.defineProperty(fn, BRUST_MW_KEY, {
    value: Object.freeze([...mws]),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return fn
}

/** Read the middleware metadata installed by withMiddleware. Used by the
 * scanner to populate ActionDef.middleware. Returns undefined for plain
 * (un-wrapped) functions. */
export function getActionMiddleware(fn: unknown): Middleware[] | undefined {
  if (typeof fn !== 'function') return undefined
  return (fn as { [BRUST_MW_KEY]?: Middleware[] })[BRUST_MW_KEY]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd runtime && bun test actions.test.ts 2>&1 | tail -10`

Expected: `8 pass / 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add runtime/actions.ts runtime/actions.test.ts
git commit -m "feat(runtime): withMiddleware + getActionMiddleware helpers

Attaches middleware metadata to server-action functions via a
non-enumerable, non-writable property. Returns the input function
unchanged so the TypeScript signature is preserved for client-side
type-only imports.

Rejects double-wrap with a clear error (composes-in-one-call hint).

Tests: 8 new unit tests cover wrap/read/freeze/reject paths.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `stripLeadingTrivia` + `hasUseServerDirective`

**Files:**
- Create: `runtime/scan-actions.ts`
- Create: `runtime/scan-actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `runtime/scan-actions.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripLeadingTrivia, hasUseServerDirective } from './scan-actions.ts'

test('stripLeadingTrivia: empty', () => {
  expect(stripLeadingTrivia('')).toBe('')
})

test('stripLeadingTrivia: pure whitespace', () => {
  expect(stripLeadingTrivia('   \n\t\r\n')).toBe('')
})

test('stripLeadingTrivia: line comment', () => {
  expect(stripLeadingTrivia('// hi\nexport')).toBe('export')
})

test('stripLeadingTrivia: block comment', () => {
  expect(stripLeadingTrivia('/* a\n b */export')).toBe('export')
})

test('stripLeadingTrivia: chained comments + whitespace', () => {
  const src = '  // a\n /* b */\n\n  // c\nexport'
  expect(stripLeadingTrivia(src)).toBe('export')
})

test('stripLeadingTrivia: unterminated block comment', () => {
  // Defensive: if a comment never closes, return empty so caller skips file.
  expect(stripLeadingTrivia('/* never closed')).toBe('')
})

async function writeFixture(dir: string, name: string, content: string): Promise<string> {
  const p = join(dir, name)
  await writeFile(p, content)
  return p
}

test('hasUseServerDirective: directive at top (single quotes)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const p = await writeFixture(dir, 'a.ts', `'use server'\nexport async function x() {}\n`)
    expect(await hasUseServerDirective(p)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: directive at top (double quotes)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const p = await writeFixture(dir, 'a.ts', `"use server"\nexport async function x() {}\n`)
    expect(await hasUseServerDirective(p)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: directive after comments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `// header\n/* block */\n'use server'\nexport async function x() {}\n`
    const p = await writeFixture(dir, 'a.ts', src)
    expect(await hasUseServerDirective(p)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: directive after import is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `import x from 'y'\n'use server'\nexport async function x() {}\n`
    const p = await writeFixture(dir, 'a.ts', src)
    expect(await hasUseServerDirective(p)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: missing directive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const p = await writeFixture(dir, 'a.ts', `export async function x() {}\n`)
    expect(await hasUseServerDirective(p)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('hasUseServerDirective: string as value not statement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const p = await writeFixture(dir, 'a.ts', `export const x = 'use server'\n`)
    expect(await hasUseServerDirective(p)).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd runtime && bun test scan-actions.test.ts 2>&1 | tail -10`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement the helpers**

Create `runtime/scan-actions.ts`:

```ts
const DIRECTIVE_HEAD_BYTES = 512

/** Remove leading whitespace, `// line comments`, and `/* block comments */`
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd runtime && bun test scan-actions.test.ts 2>&1 | tail -10`

Expected: `12 pass / 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add runtime/scan-actions.ts runtime/scan-actions.test.ts
git commit -m "feat(runtime): stripLeadingTrivia + hasUseServerDirective

First two helpers of the scan-actions module. stripLeadingTrivia walks
past whitespace + line + block comments until the first non-trivial
token; hasUseServerDirective reads the first 512 bytes and checks for
the directive at the prologue position.

Matches the TC39 directive-prologue rule (directive must be the first
statement). Files with imports before the directive are rejected.

Tests: 12 new unit tests cover comment-handling + directive-position
edge cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `collectExports`

**Files:**
- Modify: `runtime/scan-actions.ts`
- Modify: `runtime/scan-actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `runtime/scan-actions.test.ts`:

```ts
import { collectExports } from './scan-actions.ts'

test('collectExports: happy path, two named function exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\n` +
      `export async function foo(_req) { return 'foo' }\n` +
      `export async function bar(_req) { return 'bar' }\n`
    const p = await writeFixture(dir, 'a.ts', src)
    const defs = await collectExports(p)
    expect(defs.map((d) => d.id).sort()).toEqual(['bar', 'foo'])
    expect(defs.every((d) => typeof d.fn === 'function')).toBe(true)
    expect(defs.every((d) => d.middleware === undefined)).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: skips non-function exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\n` +
      `export const NAME = 'app'\n` +
      `export async function foo(_req) { return 'foo' }\n`
    const p = await writeFixture(dir, 'b.ts', src)
    const defs = await collectExports(p)
    expect(defs.map((d) => d.id)).toEqual(['foo'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: rejects default export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\n` +
      `export default async function () { return 'x' }\n`
    const p = await writeFixture(dir, 'c.ts', src)
    expect(collectExports(p)).rejects.toThrow(/default exports are not action-eligible/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: rejects class exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\n` +
      `export class Foo { static bar() {} }\n`
    const p = await writeFixture(dir, 'd.ts', src)
    expect(collectExports(p)).rejects.toThrow(/is a class/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: rejects invalid id charset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    // The function is named "x.y" via Object.defineProperty after const decl,
    // since TS doesn't allow exotic identifiers directly. We bypass with a
    // computed export name via re-export rename.
    const src = `'use server'\n` +
      `async function _impl(_req) { return 'x' }\n` +
      `export { _impl as 'bad.id' }\n`
    const p = await writeFixture(dir, 'e.ts', src)
    expect(collectExports(p)).rejects.toThrow(/invalid id/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: zero functions → throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const src = `'use server'\nexport const NAME = 'app'\n`
    const p = await writeFixture(dir, 'f.ts', src)
    expect(collectExports(p)).rejects.toThrow(/exports no functions/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectExports: picks up middleware from withMiddleware', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    // Inline withMiddleware-equivalent: write the metadata directly so the
    // fixture doesn't depend on the actions module path resolution.
    const src = `'use server'\n` +
      `async function _impl(_req) { return 'ok' }\n` +
      `Object.defineProperty(_impl, '__brustMiddleware', { value: Object.freeze([() => {}]) })\n` +
      `export { _impl as foo }\n`
    const p = await writeFixture(dir, 'g.ts', src)
    const defs = await collectExports(p)
    expect(defs).toHaveLength(1)
    expect(defs[0].middleware).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd runtime && bun test scan-actions.test.ts 2>&1 | tail -10`

Expected: FAIL with `collectExports` not exported.

- [ ] **Step 3: Implement `collectExports`**

Append to `runtime/scan-actions.ts`:

```ts
import type { ActionDef, ActionFn } from './actions.ts'
import { isValidActionId, getActionMiddleware } from './actions.ts'

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
      throw new Error(
        `${filePath}: default exports are not action-eligible. Use named export.`,
      )
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
    throw new Error(
      `${filePath}: marked 'use server' but exports no functions.`,
    )
  }
  return defs
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd runtime && bun test scan-actions.test.ts 2>&1 | tail -10`

Expected: `19 pass / 0 fail` (12 from Task 2 + 7 new).

- [ ] **Step 5: Commit**

```bash
git add runtime/scan-actions.ts runtime/scan-actions.test.ts
git commit -m "feat(runtime): collectExports for 'use server' files

Dynamically imports a file and collects named function exports as
ActionDef[]. Rejects classes (would 500 at dispatch), default exports
(must be named), invalid id charsets, and files that export zero
functions. Middleware metadata installed by withMiddleware is preserved.

Tests: 7 new unit tests cover the happy path + every rejection branch
+ middleware capture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `findCandidateFiles` + `scanActions`

**Files:**
- Modify: `runtime/scan-actions.ts`
- Modify: `runtime/scan-actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `runtime/scan-actions.test.ts`:

```ts
import { scanActions } from './scan-actions.ts'

test('scanActions: finds one server file with two exports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'actions.ts',
      `'use server'\n` +
      `export async function a(_req) {}\n` +
      `export async function b(_req) {}\n`,
    )
    await writeFixture(dir, 'plain.ts',
      `export async function notAnAction() {}\n`,
    )
    const defs = await scanActions({ roots: [dir] })
    expect(defs.map((d) => d.id)).toEqual(['a', 'b'])  // alphabetical sort
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: ignores node_modules by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'actions.ts',
      `'use server'\nexport async function a(_req) {}\n`,
    )
    // Place a second 'use server' file under node_modules.
    const nm = join(dir, 'node_modules', 'pkg')
    await Bun.write(join(nm, 'evil.ts'),
      `'use server'\nexport async function evil(_req) {}\n`,
    )
    const defs = await scanActions({ roots: [dir] })
    expect(defs.map((d) => d.id)).toEqual(['a'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: ignores test patterns by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'actions.ts',
      `'use server'\nexport async function a(_req) {}\n`,
    )
    await writeFixture(dir, 'actions.test.ts',
      `'use server'\nexport async function shouldNotAppear(_req) {}\n`,
    )
    const subTests = join(dir, 'tests')
    await Bun.write(join(subTests, 'fixture.ts'),
      `'use server'\nexport async function alsoSkipped(_req) {}\n`,
    )
    const defs = await scanActions({ roots: [dir] })
    expect(defs.map((d) => d.id)).toEqual(['a'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: custom ignore replaces defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'actions.ts',
      `'use server'\nexport async function a(_req) {}\n`,
    )
    await writeFixture(dir, 'actions.test.ts',
      `'use server'\nexport async function fromTest(_req) {}\n`,
    )
    // Custom ignore omits the test pattern → test file IS scanned.
    const defs = await scanActions({ roots: [dir], ignore: ['node_modules/**'] })
    expect(defs.map((d) => d.id).sort()).toEqual(['a', 'fromTest'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: duplicate id across files throws with both paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    const pathA = await writeFixture(dir, 'one.ts',
      `'use server'\nexport async function dupe(_req) {}\n`,
    )
    const pathB = await writeFixture(dir, 'two.ts',
      `'use server'\nexport async function dupe(_req) {}\n`,
    )
    await expect(scanActions({ roots: [dir] })).rejects.toThrow(
      new RegExp(`Duplicate action "dupe".*${pathA}.*${pathB}|Duplicate action "dupe".*${pathB}.*${pathA}`),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('scanActions: sorted alphabetical for deterministic boot logs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brust-scan-'))
  try {
    await writeFixture(dir, 'z.ts',
      `'use server'\nexport async function zebra(_req) {}\nexport async function apple(_req) {}\n`,
    )
    const defs = await scanActions({ roots: [dir] })
    expect(defs.map((d) => d.id)).toEqual(['apple', 'zebra'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd runtime && bun test scan-actions.test.ts 2>&1 | tail -10`

Expected: FAIL with `scanActions` not exported.

- [ ] **Step 3: Implement `findCandidateFiles` + `scanActions`**

Append to `runtime/scan-actions.ts`:

```ts
import { relative } from 'node:path'

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

/** Walk the project, find files whose first statement is `'use server'`,
 * import each, and return all named function exports as ActionDef[].
 * Throws on duplicate ids across files. Always returns an array sorted
 * by id for deterministic logging. */
export async function scanActions(opts: ScanOptions = {}): Promise<ActionDef[]> {
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
  return all
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd runtime && bun test scan-actions.test.ts 2>&1 | tail -10`

Expected: `25 pass / 0 fail`.

- [ ] **Step 5: Commit**

```bash
git add runtime/scan-actions.ts runtime/scan-actions.test.ts
git commit -m "feat(runtime): scanActions — boot-time 'use server' file walker

Top-level entry point: walks each root with Bun.Glob, filters by the
default ignore patterns (build outputs + test files), runs directive
checks in parallel, then imports + collects exports serially.

Cross-file duplicate ids throw with both paths. Output always sorted
alphabetically for deterministic boot logs.

Default ignore covers tests/**, __tests__/**, *.test.ts, *.spec.ts, etc.
Real-world projects often have server-shaped functions in test fixtures
that should not be auto-registered.

Tests: 6 new unit tests cover full scan, defaults, custom ignore,
duplicates, and sort order.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire `brust.scanActions` + accept `actions` in `brust.serve`

**Files:**
- Modify: `runtime/index.ts`

- [ ] **Step 1: Read current state of `runtime/index.ts`**

Confirm:
- `brust.registerActions(actions)` is the current method (lines ~72-87).
- `defineActions` and `isValidActionId` re-exported from `actions.ts` (line ~109).
- `ServeOptions` is at the top (lines 5-10).

- [ ] **Step 2: Modify `ServeOptions` to accept `actions`**

In `runtime/index.ts`, change:

```ts
export interface ServeOptions {
  port: number
  workers: number
  entry: string
  bootTimeoutMs?: number
}
```

to:

```ts
export interface ServeOptions {
  port: number
  workers: number
  entry: string
  bootTimeoutMs?: number
  /** Action definitions discovered by `brust.scanActions()`. When present,
   * `serve` calls the internal action registry before the listener binds.
   * Optional — omit if the app has no server actions. */
  actions?: ActionDef[]
}
```

Add the `ActionDef` import at the top:

```ts
import type { ActionDef } from './actions.ts'
import { isValidActionId } from './actions.ts'
```

(Replace the existing `import { isValidActionId } from './actions.ts'` line with the two-line version.)

- [ ] **Step 3: Modify `brust.serve` to register actions internally**

Change the body of `brust.serve` from:

```ts
  async serve(opts: ServeOptions): Promise<void> {
    ; (native as any).beginServe({
      port: opts.port,
      workers: opts.workers,
      entry: opts.entry,
    })
    for (let i = 0; i < opts.workers; i++) {
      // ...
    }
    // ...
  },
```

to:

```ts
  async serve(opts: ServeOptions): Promise<void> {
    if (opts.actions && opts.actions.length > 0) {
      // Register action ids with Rust. registerActionsInternal validates
      // charset + uniqueness; throws on either. Mirrors the previous
      // `brust.registerActions` user-facing call exactly.
      registerActionsInternal(opts.actions)
    }
    ; (native as any).beginServe({
      port: opts.port,
      workers: opts.workers,
      entry: opts.entry,
    })
    for (let i = 0; i < opts.workers; i++) {
      // Bun.Worker requires the JS entry (post-bundling). For the skeleton,
      // the entry is a TS file that Bun executes directly.
      new Worker(opts.entry, {
        env: { ...process.env, BRUST_WORKER_ID: String(i) },
      })
    }
    process.on('SIGINT', () => process.exit(0))
    await (native as any).untilReady(opts.bootTimeoutMs ?? 5000)
    await (native as any).untilShutdown()
  },
```

- [ ] **Step 4: Extract the existing `brust.registerActions` body into a private helper**

Move the existing `registerActions` method body into a top-level function above the `brust` object literal:

```ts
function registerActionsInternal(actions: Array<{ id: string }>): number {
  const seen = new Set<string>()
  for (const a of actions) {
    if (!isValidActionId(a.id)) {
      throw new Error(
        `action id ${JSON.stringify(a.id)} contains invalid characters; ` +
        `allowed: [A-Za-z0-9_-]+ (max 128 chars)`,
      )
    }
    if (seen.has(a.id)) {
      throw new Error(`action id ${JSON.stringify(a.id)} registered more than once`)
    }
    seen.add(a.id)
  }
  return (native as any).registerActions(actions.map((a) => a.id))
}
```

Delete the `registerActions` method from the `brust` object literal entirely. (It's still callable via `registerActionsInternal` from inside this module, but no longer on `brust`.)

- [ ] **Step 5: Add `brust.scanActions`**

Inside the `brust` object literal, add (after `configureIslandsDir`, before the closing brace):

```ts
  /** Walk the project for files marked `'use server'`, import them, and
   * return all named function exports as ActionDef[]. Both the main
   * process and each worker should call this once at module top-level
   * and pass the result to `brust.serve({ actions, ... })` (main) and
   * `makeRenderer(..., { actions, ... })` (worker). See ScanOptions for
   * roots / ignore overrides. */
  async scanActions(opts?: import('./scan-actions.ts').ScanOptions): Promise<ActionDef[]> {
    const { scanActions } = await import('./scan-actions.ts')
    return scanActions(opts)
  },
```

- [ ] **Step 6: Drop the public re-exports of `defineActions`**

Change:

```ts
export { defineActions, isValidActionId } from './actions.ts'
export type { ActionDef, ActionFn } from './actions.ts'
```

to:

```ts
export { withMiddleware, isValidActionId } from './actions.ts'
export type { ActionDef, ActionFn } from './actions.ts'
export type { ScanOptions } from './scan-actions.ts'
```

`defineActions` is gone from the public surface. `withMiddleware` takes its slot.

- [ ] **Step 7: Run all runtime unit tests to verify nothing regressed**

Run: `cd runtime && bun test 2>&1 | tail -5`

Expected: All previous unit tests still pass; the new ones from Tasks 1-4 also pass.

- [ ] **Step 8: Type-check the runtime against current state**

Run: `cd runtime && bunx tsc --noEmit 2>&1 | tail -20`

Expected: no type errors. If any, they will most likely be from `example/hello-world` still importing `defineActions` (handled in Task 6).

(Note: `bunx tsc` may report errors from example/ — those are addressed in Task 6. Focus on errors inside `runtime/` itself.)

- [ ] **Step 9: Commit**

```bash
git add runtime/index.ts
git commit -m "feat(runtime): expose brust.scanActions, register inside brust.serve

- New brust.scanActions(opts?) returns the ActionDef[] discovered from
  'use server' files. Lazily imports scan-actions.ts so apps without
  server actions pay no startup cost.
- brust.serve(opts) gains an optional 'actions' field; when present,
  registers ids with Rust before binding the listener.
- Public defineActions / brust.registerActions removed. Internal
  registerActionsInternal still exists and is called from serve().
- withMiddleware added to the public re-export list.
- ScanOptions type re-exported for users wanting to customise scan
  roots/ignore.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Migrate the example app

**Files:**
- Modify: `example/hello-world/actions.ts`
- Modify: `example/hello-world/index.ts`

- [ ] **Step 1: Add `'use server'` + `withMiddleware` to `actions.ts`**

Open `example/hello-world/actions.ts`. Replace its entire contents with:

```ts
'use server'
import { withMiddleware } from '../../runtime/index.ts'
import type { BrustRequest, Middleware } from '../../runtime/index.ts'

const requireUser: Middleware = async (req, next) => {
  if (!req.cookies['user']) {
    return { status: 401, body: 'login required' }
  }
  return next()
}

/** Demo action: pretend to insert a note and return a generated id. */
export async function createNote(req: BrustRequest, text: string): Promise<{ id: string }> {
  if (typeof text !== 'string') throw new Error('text must be a string')
  if (text.length > 1000) throw new Error('text too long (max 1000)')
  return { id: 'n-' + Date.now() }
}

/** Demo action: returns whoever the `user` cookie says they are, or null. */
export async function whoAmI(req: BrustRequest): Promise<{ user: string | null }> {
  return { user: req.cookies['user'] ?? null }
}

/** Demo action: gated by requireUser middleware via the withMiddleware wrapper. */
export const deleteNote = withMiddleware(
  [requireUser],
  async (req: BrustRequest, noteId: string): Promise<{ ok: true }> => {
    if (typeof noteId !== 'string' || noteId.length === 0) {
      throw new Error('noteId must be a non-empty string')
    }
    return { ok: true }
  },
)

/** Demo action that returns nothing — exercises the empty-body wire path
 * (status 200, Content-Length: 0). Real use cases: fire-and-forget analytics
 * pings, log events. */
export async function pingAction(_req: BrustRequest): Promise<void> {
  // intentionally empty
}
```

- [ ] **Step 2: Replace manual registration in `index.ts`**

Open `example/hello-world/index.ts`. Change:

```ts
import { brust, isWorker, loadConfig, makeRenderer, buildIslands, defineActions, type Middleware } from '../../runtime/index.ts'
import { routes } from './routes'
import { createNote, whoAmI, deleteNote, pingAction } from './actions'

// Auth middleware to demo on the deleteNote action.
const requireUser: Middleware = async (req, next) => {
  if (!req.cookies['user']) {
    return { status: 401, body: 'login required' }
  }
  return next()
}

const actions = defineActions([
  { id: 'createNote', fn: createNote },
  { id: 'whoAmI',     fn: whoAmI },
  { id: 'deleteNote', fn: deleteNote, middleware: [requireUser] },
  { id: 'pingAction', fn: pingAction },
])
```

to:

```ts
import { brust, isWorker, loadConfig, makeRenderer, buildIslands } from '../../runtime/index.ts'
import { routes } from './routes'

// Scope the scan to this dir — `bun test` runs from the brust repo root, so
// default cwd would otherwise pick up other example apps + test fixtures.
const actions = await brust.scanActions({ roots: [import.meta.dirname] })
```

Then change the main-process block:

```ts
if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  if (cacheMaxEntries !== undefined) {
    brust.configureCache({ maxEntries: cacheMaxEntries })
  }
  const islands = await buildIslands(
    new URL('./island.config.ts', import.meta.url).pathname,
  )
  brust.configureIslandsDir(islands.outDir)
  console.log(`[brust] main: built ${islands.islandCount} island chunk(s)`)
  brust.registerRoutes(routes)
  brust.registerActions(actions)
  console.log(`[brust] main: registered ${actions.length} action(s)`)

  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
  })
} else {
```

to:

```ts
if (!isWorker) {
  const { port, workers, cacheMaxEntries } = await loadConfig()
  console.log(`[brust] main: spawning ${workers} worker threads`)

  if (cacheMaxEntries !== undefined) {
    brust.configureCache({ maxEntries: cacheMaxEntries })
  }
  const islands = await buildIslands(
    new URL('./island.config.ts', import.meta.url).pathname,
  )
  brust.configureIslandsDir(islands.outDir)
  console.log(`[brust] main: built ${islands.islandCount} island chunk(s)`)
  brust.registerRoutes(routes)
  console.log(`[brust] main: scanActions found ${actions.length} action(s): ${actions.map((a) => a.id).join(', ')}`)

  await brust.serve({
    port,
    workers,
    entry: import.meta.url,
    actions,
  })
} else {
```

The worker block stays unchanged (it already passes `actions` to `makeRenderer`).

- [ ] **Step 3: Confirm both files type-check**

Run: `cd runtime && bunx tsc --noEmit 2>&1 | grep -E "example/hello-world|error" | head -20`

Expected: no errors from `example/hello-world`. If the path resolution complains about `import.meta.dirname`, ensure the file is .ts (it is) — Bun 1.4 supports `import.meta.dirname` natively.

- [ ] **Step 4: Sanity-launch the app manually**

Build a release napi addon if needed, then launch:

```bash
cd runtime && bun run build:debug && cd -
BRUST_PORT=38900 bun run example/hello-world/index.ts &
sleep 6
```

Expected stdout (within the first few seconds):

```
[brust] main: spawning N worker threads
[brust] main: built 2 island chunk(s)
[brust] main: scanActions found 4 action(s): createNote, deleteNote, pingAction, whoAmI
[brust] listening on 127.0.0.1:38900 (io: ...)
```

Smoke-test the action endpoint:

```bash
curl -s -X POST -H 'content-type: application/json' \
  --data '["hi"]' http://127.0.0.1:38900/_brust/action/createNote
# expected: {"id":"n-<unix-ms>"}

curl -si -X POST -H 'content-type: application/json' \
  --data '["n-1"]' http://127.0.0.1:38900/_brust/action/deleteNote | head -1
# expected: HTTP/1.1 401 Unauthorized

curl -s -X POST -H 'content-type: application/json' -H 'cookie: user=alice' \
  --data '["n-1"]' http://127.0.0.1:38900/_brust/action/deleteNote
# expected: {"ok":true}
```

Kill the server:

```bash
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add example/hello-world/actions.ts example/hello-world/index.ts
git commit -m "feat(example): migrate hello-world to 'use server' directive

actions.ts gains the file-level 'use server' directive and moves the
requireUser middleware in from index.ts (where it belonged anyway —
the middleware is action-specific). deleteNote now uses
withMiddleware([requireUser], ...) for explicit per-action binding.

index.ts replaces the manual defineActions + brust.registerActions
chain with await brust.scanActions({ roots: [import.meta.dirname] }).
The scoped root prevents the scanner from picking up other example
apps or test fixtures when bun test launches the app from the repo
root.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Verify the full test suite still passes

**Files:**
- Verify: `tests/integration.test.ts`

- [ ] **Step 1: Build the release napi addon (if not already)**

```bash
cd runtime && bun run build:debug && cd -
```

Expected: warning about pre-existing dead_code on shutdown, otherwise clean.

- [ ] **Step 2: Run the full integration test suite**

```bash
bun test tests/integration.test.ts 2>&1 | tail -10
```

Expected: `30 pass / 0 fail / 139+ expect() calls`.

If any test fails:
1. Read the failing test's expectations.
2. Check whether the failure is environmental (port collision, slow boot) — retry once.
3. If reproducible, the migration broke a contract. Most likely culprits:
   - Boot timeout too short for the added scan step → bump `BRUST_PORT` env or `bootTimeoutMs` if exposed; or
   - The example app's `actions` array now arrives sorted (a → b → ... → z) instead of insertion order; if any test asserts a specific id order, fix the test assertion.
4. Fix and re-run.

- [ ] **Step 3: Run the runtime unit tests too**

```bash
cd runtime && bun test 2>&1 | tail -5
```

Expected: All scan-actions + actions unit tests still pass (25 + 8 = 33 tests).

- [ ] **Step 4: Confirm Rust unit tests are unaffected**

```bash
cargo test --lib 2>&1 | tail -5
```

Expected: `47 pass / 0 fail`. (No Rust changes were made.)

- [ ] **Step 5: Commit any test fixups (likely none)**

If Step 2 required a test adjustment:

```bash
git add tests/integration.test.ts
git commit -m "test(integration): adjust assertions for sorted scanActions output

After Task 6 the example app calls brust.scanActions() which sorts
the returned ActionDef[] alphabetically. Existing tests that asserted
insertion order need updating to match.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If no changes were needed: skip this step.

---

## Task 8: Update `architecture.md`

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Find the "Built vs Designed not built" lists**

```bash
grep -n "Built\|Designed not built\|use server" architecture.md | head -20
```

The lists live near the bottom (sessions 1-5 evolved them). Find the "Designed not built" entry for `"use server"` directive and the "Built" list to add to.

- [ ] **Step 2: Move `"use server"` from "Designed not built" to "Built"**

Locate the bullet that says:

```markdown
- **`"use server"` directive + auto-rewrite** — replaces manual `registerActions` array, MVP-style. Runtime surface ready; needs scanner + manifest generator. ~2 days.
```

Delete it from the "Designed not built" list.

Add to the "Built" list:

```markdown
- **`"use server"` directive + boot-time scanner** — file-level directive. `brust.scanActions({ roots? })` walks the project, finds files whose first statement is `'use server'`, imports them, and registers all named function exports as actions. Middleware attaches per-action via `withMiddleware([mws], fn)`. Replaces the manual `defineActions` / `brust.registerActions` API.
```

- [ ] **Step 3: Add the new files to the file-structure cheat-sheet**

Find the file-structure section (search for `runtime/` or `scan-actions`):

```bash
grep -n "runtime/" architecture.md | head -10
```

Add these entries under `runtime/`:

```
├── actions.ts                                          # + withMiddleware, getActionMiddleware
├── actions.test.ts                                     # NEW — unit tests for the helpers
├── scan-actions.ts                                     # NEW — Bun.glob + dynamic import scanner
├── scan-actions.test.ts                                # NEW — unit tests with temp-dir fixtures
```

(Match the formatting of nearby lines.)

- [ ] **Step 4: Update the public API surface section if it exists**

Look for any section listing `brust.registerActions` or `defineActions`:

```bash
grep -n "registerActions\|defineActions" architecture.md
```

If found, update the listing to reflect:
- `brust.scanActions(opts?)` — discovers actions at boot.
- `brust.serve({ ..., actions })` — accepts the result.
- `withMiddleware([...], fn)` — attaches per-action middleware.

Remove mentions of `defineActions` and `brust.registerActions` from the user-facing API list (they're now internal).

- [ ] **Step 5: Verify nothing else stale**

```bash
grep -n "registerActions\|defineActions" architecture.md
```

Expected: empty result, OR only internal-implementation context mentions.

- [ ] **Step 6: Commit**

```bash
git add architecture.md
git commit -m "docs(architecture): 'use server' directive shipped

Moves the entry from 'Designed not built' to 'Built'. Updates the file
structure cheat-sheet for runtime/scan-actions.ts + runtime/actions.test.ts.
Updates the public API section to drop defineActions / registerActions
in favour of brust.scanActions + withMiddleware.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Spec coverage check (self-review)

Spec section → task that implements it:

| Spec § | Task |
|---|---|
| §2.1 Directive recognition | Task 2 (`hasUseServerDirective`) |
| §2.2 `withMiddleware` helper | Task 1 |
| §2.3 `brust.scanActions(opts?)` | Task 4 (impl) + Task 5 (expose) |
| §2.4 `brust.serve({..., actions})` | Task 5 |
| §2.5 Drop public `defineActions` / `registerActions` | Task 5 |
| §3.1 `findCandidateFiles` | Task 4 |
| §3.2 `stripLeadingTrivia` + directive check | Task 2 |
| §3.3 `collectExports` (class + default rejection) | Task 3 |
| §3.4 Duplicate id throws | Task 4 |
| §3.5 Concurrency (parallel checks, serial imports) | Task 4 |
| §4 Worker coordination | Task 6 (example reuses worker block) + Task 7 (verify) |
| §5 Error handling | Tasks 3 + 4 (scan-time errors); existing runtime handles 404/500 |
| §6 Type safety | Unchanged — no task; verified in Task 7 |
| §7 Migration of example | Task 6 |
| §8.1 Unit tests | Tasks 1-4 |
| §8.2 Integration tests | Task 7 (verification only — no new tests; the existing 11 action tests + 1 island test cover the surface) |
| §9 Risks | Mitigated: defaults updated (Task 4), class rejected (Task 3), double-wrap rejected (Task 1) |
| §10 Implementation order | Tasks 1-8 below |

All spec sections covered. No tasks added speculatively beyond the spec.
