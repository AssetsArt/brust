# `brust new` Scaffolding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `brust new <name>` — a CLI subcommand that scaffolds a fresh brust app (Tailwind + one island + one route) into a new directory, with a `file:`-ref to this repo so the scaffolded project installs and boots end-to-end.

**Architecture:** New file `runtime/cli/new.ts` (orchestrator) + template directory at `runtime/cli/templates/minimal/` (committed assets). Wired into existing dispatcher at `runtime/cli/index.ts`. Two prerequisite changes to root `package.json`: move React to `peerDependencies` (avoid dual-copy crash) and add an `exports` map (so templates can `import from 'brust'`).

**Tech Stack:** Bun (test runner + spawn), Node fs APIs (`mkdir`, `readdir`, `cp`, `readFile`, `writeFile`), the existing CLI pattern from `runtime/cli/build.ts`.

**Spec:** `docs/superpowers/specs/2026-05-27-brust-new-scaffolding-design.md`

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `runtime/cli/new.ts` | Orchestrator. Exports `runNew(args)`. Contains `parseArgs`, `validateTarget`, `resolveBrustRef`, `copyTemplate`, `printNextSteps`. |
| `runtime/cli/templates/minimal/_gitignore` | Renamed to `.gitignore` on emit. |
| `runtime/cli/templates/minimal/package.json.tmpl` | Has `__PROJECT_NAME__` and `__BRUST_DEP__`. |
| `runtime/cli/templates/minimal/tsconfig.json` | Static copy. |
| `runtime/cli/templates/minimal/index.ts` | Static. 3 lines. |
| `runtime/cli/templates/minimal/routes.tsx` | Static. |
| `runtime/cli/templates/minimal/island.config.ts` | Static. |
| `runtime/cli/templates/minimal/app.css` | Static. |
| `runtime/cli/templates/minimal/README.md.tmpl` | Has `__PROJECT_NAME__`. |
| `runtime/cli/templates/minimal/pages/Home.tsx.tmpl` | Has `__PROJECT_NAME__`. |
| `runtime/cli/templates/minimal/components/Layout.tsx` | Static. |
| `runtime/cli/templates/minimal/components/Counter.tsx` | Static. |
| `tests/cli-new.test.ts` | Integration tests. |

**Modified files:**

| Path | Change |
|---|---|
| `runtime/cli/index.ts` | Add `case 'new'` dispatch. |
| `package.json` | Move `react`/`react-dom` to `peerDependencies`. Add `exports` map. Remove stale `"module": "index.ts"`. |

---

## Task 1: Prerequisites — `package.json` exports + React peer-deps

**Files:**
- Modify: `package.json`

**Why first:** the template uses `from 'brust'` and `from 'brust/routes'`. Those resolve via `exports`. Also, leaving `react` in `dependencies` of the root produces a dual React copy when a scaffolded project also installs React → SSR crash (per `architecture.md`).

- [ ] **Step 1: Read current `package.json`**

Run: `cat package.json`
Expected: see `"module": "index.ts"`, `dependencies` with `react`, `react-dom`, `@tailwindcss/*`, `smol-toml`. No `exports` field.

- [ ] **Step 2: Apply edit**

Use Edit. Replace:

```json
  "module": "index.ts",
  "type": "module",
  "scripts": {
```

With:

```json
  "type": "module",
  "exports": {
    ".": "./runtime/index.ts",
    "./routes": "./runtime/routes.ts"
  },
  "scripts": {
```

Then replace:

```json
  "dependencies": {
    "@tailwindcss/node": "^4.3.0",
    "@tailwindcss/oxide": "^4.3.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "smol-toml": "^1.3.1"
  },
```

With:

```json
  "dependencies": {
    "@tailwindcss/node": "^4.3.0",
    "@tailwindcss/oxide": "^4.3.0",
    "smol-toml": "^1.3.1"
  },
  "peerDependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
```

- [ ] **Step 3: Verify the repo still installs cleanly**

Run: `bun install`
Expected: completes without error. `node_modules/react` and `node_modules/react-dom` both still present (Bun installs peer deps when `@types/react*` devDeps depend on them).

- [ ] **Step 4: Verify existing tests still green**

Run: `bun test tests/cli-build.test.ts`
Expected: 7 pass. (This proves the existing example app still boots after the peer-deps shift.)

Run: `bun test runtime/`
Expected: 188 pass.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore(package): exports map + react peer-deps

Prep for brust new scaffolding. Adds:
- exports map: '.' → runtime/index.ts, './routes' → runtime/routes.ts
  so consumers can do \`from 'brust'\` / \`from 'brust/routes'\`.
- react + react-dom moved to peerDependencies to avoid dual-copy SSR
  crash when scaffolded projects also declare them.
- Drops stale \`module: index.ts\` (pointed at nothing).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Template static files (no substitution)

**Files:**
- Create: `runtime/cli/templates/minimal/_gitignore`
- Create: `runtime/cli/templates/minimal/tsconfig.json`
- Create: `runtime/cli/templates/minimal/index.ts`
- Create: `runtime/cli/templates/minimal/routes.tsx`
- Create: `runtime/cli/templates/minimal/island.config.ts`
- Create: `runtime/cli/templates/minimal/app.css`
- Create: `runtime/cli/templates/minimal/components/Layout.tsx`
- Create: `runtime/cli/templates/minimal/components/Counter.tsx`

No tests for this task — these are static assets exercised by the Task 7 integration test.

- [ ] **Step 1: Create `_gitignore`**

```
node_modules/
.brust/
dist/
brust.toml
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "jsx": "react-jsx",
    "allowJs": true,
    "types": ["bun"],
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true
  }
}
```

- [ ] **Step 3: Create `index.ts`**

```ts
import { brust } from 'brust'
import { routes } from './routes'

await brust.run({ routes, entry: import.meta.url })
```

- [ ] **Step 4: Create `routes.tsx`**

```tsx
import { defineRoutes } from 'brust/routes'
import Home from './pages/Home'

export const routes = defineRoutes([
  { path: '/', Component: Home },
])
```

- [ ] **Step 5: Create `island.config.ts`**

```ts
export default {
  islands: {
    Counter: './components/Counter.tsx',
  },
}
```

- [ ] **Step 6: Create `app.css`**

```css
@import "tailwindcss";
@source "./**/*.{tsx,ts}";

@theme {
  --color-brand: #2563eb;
}
```

- [ ] **Step 7: Create `components/Layout.tsx`**

```tsx
import type { ReactNode } from 'react'

export default function Layout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
      </head>
      <body className="bg-white text-gray-900 font-sans">
        <main className="max-w-3xl mx-auto px-5 py-8">{children}</main>
      </body>
    </html>
  )
}
```

- [ ] **Step 8: Create `components/Counter.tsx`**

```tsx
import { useState } from 'react'

export default function Counter({ start = 0, label = 'count' }: { start?: number; label?: string }) {
  const [n, setN] = useState(start)
  return (
    <button
      onClick={() => setN(n + 1)}
      className="px-3 py-1.5 bg-brand text-white rounded text-sm hover:opacity-90 transition-opacity"
    >
      {label}: {n}
    </button>
  )
}
```

- [ ] **Step 9: Verify all 8 files exist**

Run: `ls -la runtime/cli/templates/minimal/ runtime/cli/templates/minimal/components/`
Expected: 6 files at top level (`_gitignore`, `tsconfig.json`, `index.ts`, `routes.tsx`, `island.config.ts`, `app.css`), 2 in `components/`.

- [ ] **Step 10: Commit**

```bash
git add runtime/cli/templates/minimal/
git commit -m "feat(scaffold): static template files for brust new

The non-substituted half of the minimal template — gitignore,
tsconfig, entry, routes, island config, app.css, Layout, Counter.
Substituted files (package.json, README, Home.tsx) come next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Template files with substitution

**Files:**
- Create: `runtime/cli/templates/minimal/package.json.tmpl`
- Create: `runtime/cli/templates/minimal/README.md.tmpl`
- Create: `runtime/cli/templates/minimal/pages/Home.tsx.tmpl`

- [ ] **Step 1: Create `package.json.tmpl`**

```json
{
  "name": "__PROJECT_NAME__",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "brust dev",
    "build": "brust build"
  },
  "dependencies": {
    "brust": __BRUST_DEP__,
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "typescript": "^5.5.0"
  }
}
```

Note: `__BRUST_DEP__` is NOT in quotes — the substituted value is a JSON-encoded string (e.g. `"file:/abs/path"` or `"^0.1.0"`), so the placeholder appears in JSON value position directly.

- [ ] **Step 2: Create `README.md.tmpl`**

```markdown
# __PROJECT_NAME__

Scaffolded with `brust new`.

## Develop

    bun install
    bun run dev

Open http://127.0.0.1:3000.

## Build

    bun run build

Outputs a standalone `dist/` you can ship — `bun run dist/index.js` boots the server.
```

- [ ] **Step 3: Create `pages/Home.tsx.tmpl`**

```tsx
import { Island } from 'brust'
import Layout from '../components/Layout'
import Counter from '../components/Counter'

export default function Home() {
  return (
    <Layout title="__PROJECT_NAME__">
      <h1 className="text-3xl font-bold mb-4">Welcome to brust</h1>
      <p className="mb-4 text-gray-700">
        Edit <code className="bg-gray-100 px-1 rounded">pages/Home.tsx</code> and save —
        <code className="bg-gray-100 px-1 rounded ml-1">brust dev</code> will reload.
      </p>
      <Island component={Counter} props={{ start: 0, label: 'clicks' }} hydrate="load" />
    </Layout>
  )
}
```

- [ ] **Step 4: Verify**

Run: `ls runtime/cli/templates/minimal/*.tmpl runtime/cli/templates/minimal/pages/`
Expected: 3 `.tmpl` files visible.

- [ ] **Step 5: Commit**

```bash
git add runtime/cli/templates/minimal/
git commit -m "feat(scaffold): substituted template files

package.json.tmpl (project name + brust dep ref), README.md.tmpl,
pages/Home.tsx.tmpl. The .tmpl suffix is the runNew substitution marker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `parseArgs` — TDD

**Files:**
- Create: `runtime/cli/new.ts` (test-first; just enough to make tests fail to import)
- Create: `tests/cli-new.test.ts`

- [ ] **Step 1: Write failing tests for `parseArgs`**

Create `tests/cli-new.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { parseArgs } from '../runtime/cli/new.ts'
import path from 'node:path'

test('parseArgs: positional name → targetDir = cwd/<name>', () => {
  const result = parseArgs(['my-app'])
  expect(result.projectName).toBe('my-app')
  expect(result.targetDir).toBe(path.resolve(process.cwd(), 'my-app'))
})

test('parseArgs: --dir overrides target', () => {
  const result = parseArgs(['my-app', '--dir', '/tmp/foo'])
  expect(result.targetDir).toBe('/tmp/foo')
})

test('parseArgs: --dir=value form', () => {
  const result = parseArgs(['my-app', '--dir=/tmp/bar'])
  expect(result.targetDir).toBe('/tmp/bar')
})

test('parseArgs: relative --dir resolved against cwd', () => {
  const result = parseArgs(['my-app', '--dir', './subdir'])
  expect(result.targetDir).toBe(path.resolve(process.cwd(), 'subdir'))
})

test('parseArgs: missing name throws', () => {
  expect(() => parseArgs([])).toThrow(/missing project name/)
})

test('parseArgs: unknown flag throws', () => {
  expect(() => parseArgs(['my-app', '--bogus'])).toThrow(/unknown flag/)
})

test('parseArgs: --dir without value throws', () => {
  expect(() => parseArgs(['my-app', '--dir'])).toThrow(/--dir requires a value/)
})

test('parseArgs: invalid project name throws (uppercase)', () => {
  expect(() => parseArgs(['MyApp'])).toThrow(/invalid project name/)
})

test('parseArgs: invalid project name throws (starts with hyphen)', () => {
  expect(() => parseArgs(['-foo'])).toThrow(/unknown flag/)
})

test('parseArgs: invalid project name throws (space)', () => {
  expect(() => parseArgs(['foo bar'])).toThrow(/invalid project name/)
})

test('parseArgs: digit-start name is valid', () => {
  const result = parseArgs(['1-foo'])
  expect(result.projectName).toBe('1-foo')
})

test('parseArgs: name too long throws', () => {
  const long = 'a'.repeat(51)
  expect(() => parseArgs([long])).toThrow(/too long/)
})
```

- [ ] **Step 2: Create skeleton `runtime/cli/new.ts`**

```ts
export interface ParsedNewArgs {
  projectName: string
  targetDir: string
}

export function parseArgs(_args: string[]): ParsedNewArgs {
  throw new Error('not implemented')
}

export async function runNew(_args: string[]): Promise<void> {
  throw new Error('not implemented')
}
```

- [ ] **Step 3: Run tests, confirm they fail**

Run: `bun test tests/cli-new.test.ts`
Expected: 12 failures with `not implemented` or invalid project name regex mismatches.

- [ ] **Step 4: Implement `parseArgs`**

Replace the body of `parseArgs` in `runtime/cli/new.ts`:

```ts
import { isAbsolute, resolve } from 'node:path'

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/
const MAX_NAME_LEN = 50

export interface ParsedNewArgs {
  projectName: string
  targetDir: string
}

export function parseArgs(args: string[]): ParsedNewArgs {
  let name: string | undefined
  let dir: string | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--dir') {
      dir = args[++i]
      if (!dir) throw new Error('brust new: --dir requires a value')
    } else if (a.startsWith('--dir=')) {
      dir = a.slice('--dir='.length)
    } else if (a.startsWith('-')) {
      throw new Error(`brust new: unknown flag "${a}"`)
    } else if (name === undefined) {
      name = a
    } else {
      throw new Error(`brust new: unexpected positional argument "${a}"`)
    }
  }

  if (!name) {
    throw new Error('brust new: missing project name. Usage: brust new <name> [--dir <path>]')
  }
  if (name.length > MAX_NAME_LEN) {
    throw new Error(`brust new: project name too long (max ${MAX_NAME_LEN} chars)`)
  }
  if (!NAME_RE.test(name)) {
    throw new Error(
      `brust new: invalid project name "${name}" — use lowercase letters, digits, hyphens, underscores; must start with a letter or digit`,
    )
  }

  const cwd = process.cwd()
  const targetDir = dir
    ? (isAbsolute(dir) ? dir : resolve(cwd, dir))
    : resolve(cwd, name)

  return { projectName: name, targetDir }
}

export async function runNew(_args: string[]): Promise<void> {
  throw new Error('not implemented')
}
```

- [ ] **Step 5: Run tests, confirm all 12 pass**

Run: `bun test tests/cli-new.test.ts`
Expected: 12 pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/cli/new.ts tests/cli-new.test.ts
git commit -m "feat(cli): parseArgs for brust new

Positional <name> + --dir flag. Validates name against
/^[a-z0-9][a-z0-9_-]*$/, max 50 chars. 12 unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `resolveBrustRef` — TDD

**Files:**
- Modify: `runtime/cli/new.ts`
- Modify: `tests/cli-new.test.ts` (append)

- [ ] **Step 1: Append failing tests**

Append to `tests/cli-new.test.ts`:

```ts
import { resolveBrustRef } from '../runtime/cli/new.ts'

test('resolveBrustRef: detects source tree (this repo)', () => {
  const ref = resolveBrustRef()
  expect(ref.kind).toBe('file')
  expect(ref.spec).toMatch(/^file:/)
  // Must point at an absolute path that contains Cargo.toml + src + runtime/cli/index.ts.
  const dir = ref.spec.slice('file:'.length)
  expect(path.isAbsolute(dir)).toBe(true)
  expect(Bun.file(path.join(dir, 'Cargo.toml')).size).toBeGreaterThan(0)
  expect(Bun.file(path.join(dir, 'runtime/cli/index.ts')).size).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test tests/cli-new.test.ts -t resolveBrustRef`
Expected: fail with "resolveBrustRef is not a function" or similar.

- [ ] **Step 3: Implement `resolveBrustRef`**

Add to `runtime/cli/new.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface BrustRef {
  kind: 'file' | 'version'
  spec: string  // JSON-encoded string value (e.g. "file:/abs" or "^0.1.0")
}

function hasSourceMarkers(dir: string): boolean {
  return existsSync(join(dir, 'Cargo.toml'))
    && existsSync(join(dir, 'src'))
    && existsSync(join(dir, 'runtime/cli/index.ts'))
}

export function resolveBrustRef(startDir: string = import.meta.dir): BrustRef {
  let dir = startDir
  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name === 'brust') {
          if (hasSourceMarkers(dir)) {
            return { kind: 'file', spec: `file:${dir}` }
          }
          const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
          return { kind: 'version', spec: `^${version}` }
        }
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('brust new: cannot locate the brust package — is your installation intact?')
    }
    dir = parent
  }
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test tests/cli-new.test.ts -t resolveBrustRef`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add runtime/cli/new.ts tests/cli-new.test.ts
git commit -m "feat(cli): resolveBrustRef walks ancestors for brust package

Upward-walks from import.meta.dir for a package.json named 'brust'.
If the directory also contains Cargo.toml + src/ + runtime/cli/index.ts,
emits a file: spec. Otherwise emits a caret version range. Hard-errors
when no brust package is found in any ancestor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `copyTemplate` — TDD

**Files:**
- Modify: `runtime/cli/new.ts`
- Modify: `tests/cli-new.test.ts` (append)

- [ ] **Step 1: Append failing tests**

```ts
import { copyTemplate } from '../runtime/cli/new.ts'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

test('copyTemplate: strips .tmpl suffix and substitutes', async () => {
  const tmpl = await mkdtemp(path.join(tmpdir(), 'brust-tmpl-src-'))
  const target = await mkdtemp(path.join(tmpdir(), 'brust-tmpl-dst-'))
  try {
    await Bun.write(path.join(tmpl, 'a.txt'), 'static content\n')
    await Bun.write(path.join(tmpl, 'b.txt.tmpl'), 'name=__PROJECT_NAME__\n')
    await Bun.write(path.join(tmpl, '_gitignore'), 'node_modules/\n')

    await copyTemplate({
      templateDir: tmpl,
      targetDir: target,
      substitutions: { __PROJECT_NAME__: 'hello' },
    })

    expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('static content\n')
    expect(await readFile(path.join(target, 'b.txt'), 'utf8')).toBe('name=hello\n')
    expect(await readFile(path.join(target, '.gitignore'), 'utf8')).toBe('node_modules/\n')
    // _gitignore should not exist
    const entries = await readdir(target)
    expect(entries).not.toContain('_gitignore')
    expect(entries).not.toContain('b.txt.tmpl')
  } finally {
    await rm(tmpl, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('copyTemplate: recurses into subdirectories', async () => {
  const tmpl = await mkdtemp(path.join(tmpdir(), 'brust-tmpl-src-'))
  const target = await mkdtemp(path.join(tmpdir(), 'brust-tmpl-dst-'))
  try {
    await Bun.write(path.join(tmpl, 'sub/nested.txt'), 'deep\n')
    await Bun.write(path.join(tmpl, 'sub/deep.tmpl'), 'X=__X__')

    await copyTemplate({
      templateDir: tmpl,
      targetDir: target,
      substitutions: { __X__: '42' },
    })

    expect(await readFile(path.join(target, 'sub/nested.txt'), 'utf8')).toBe('deep\n')
    expect(await readFile(path.join(target, 'sub/deep'), 'utf8')).toBe('X=42')
  } finally {
    await rm(tmpl, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('copyTemplate: throws if templateDir missing', async () => {
  await expect(copyTemplate({
    templateDir: '/no/such/dir',
    targetDir: '/tmp/whatever',
    substitutions: {},
  })).rejects.toThrow(/template directory/)
})
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test tests/cli-new.test.ts -t copyTemplate`
Expected: failures (function not exported).

- [ ] **Step 3: Implement `copyTemplate`**

Add to `runtime/cli/new.ts`:

```ts
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'

export interface CopyTemplateOpts {
  templateDir: string
  targetDir: string
  substitutions: Record<string, string>
}

export async function copyTemplate(opts: CopyTemplateOpts): Promise<void> {
  if (!existsSync(opts.templateDir)) {
    throw new Error(`brust new: template directory not found at ${opts.templateDir}; this is a brust installation bug`)
  }
  await copyDir(opts.templateDir, opts.targetDir, opts.substitutions)
}

async function copyDir(src: string, dst: string, subs: Record<string, string>): Promise<void> {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const ent of entries) {
    const srcPath = join(src, ent.name)
    const dstName = renameForEmit(ent.name)
    const dstPath = join(dst, dstName)
    if (ent.isDirectory()) {
      await copyDir(srcPath, dstPath, subs)
    } else if (ent.isFile()) {
      const isTmpl = ent.name.endsWith('.tmpl')
      if (isTmpl) {
        const raw = await readFile(srcPath, 'utf8')
        const out = applySubstitutions(raw, subs)
        await writeFile(dstPath, out)
      } else {
        const buf = await readFile(srcPath)
        await writeFile(dstPath, buf)
      }
    }
  }
}

function renameForEmit(name: string): string {
  if (name.endsWith('.tmpl')) return name.slice(0, -'.tmpl'.length)
  if (name === '_gitignore') return '.gitignore'
  return name
}

function applySubstitutions(text: string, subs: Record<string, string>): string {
  let out = text
  for (const [key, value] of Object.entries(subs)) {
    out = out.split(key).join(value)
  }
  return out
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test tests/cli-new.test.ts -t copyTemplate`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add runtime/cli/new.ts tests/cli-new.test.ts
git commit -m "feat(cli): copyTemplate recursively emits files

.tmpl suffix is the substitution marker (stripped on emit).
_gitignore renames to .gitignore (defensive against publish strip).
Static files copied byte-for-byte. Throws if templateDir is missing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `runNew` orchestrator + CLI wiring + integration test

> **As shipped:** the orchestrator and CLI wiring landed as written. The heavy `bun install + bun run dev + curl /` test was DEFERRED — empirically blocked by the dual-React limitation (see the spec's `Known limitations` section). Replaced with a lighter `brust new: scaffold emits the expected tree and content` assertion that verifies file tree, package.json shape, and substitution leakage. The boot smoke will re-land when the workspace restructure follow-up unblocks it.

**Files:**
- Modify: `runtime/cli/new.ts` (replace `runNew` body)
- Modify: `runtime/cli/index.ts` (add `case 'new'`)
- Modify: `tests/cli-new.test.ts` (append integration test)

- [ ] **Step 1: Append integration test**

```ts
import { spawn, $ } from 'bun'
import { existsSync } from 'node:fs'

const REPO = path.resolve(import.meta.dir, '..')

test('brust new: missing name → exit 1', async () => {
  const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} new`.nothrow()
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('missing project name')
})

test('brust new: invalid name → exit 1', async () => {
  const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} new MyApp`.nothrow()
  expect(result.exitCode).toBe(1)
  expect(result.stderr.toString()).toContain('invalid project name')
})

test('brust new: non-empty target dir → exit 1', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brust-new-nonempty-'))
  try {
    await Bun.write(path.join(dir, 'something'), 'x')
    const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} new test --dir ${dir}`.nothrow()
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('not empty')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('brust new: scaffold → install → bun run dev → curl /', async () => {
  // Prerequisite: native binary built. Skip with clear message if not.
  const nativeFiles = (await readdir(path.join(REPO, 'runtime'))).filter((f) => /^index\..+\.node$/.test(f))
  if (nativeFiles.length === 0) {
    console.warn('SKIP: native .node binary not built. Run `cd runtime && bun run build` first.')
    return
  }

  const parent = await mkdtemp(path.join(tmpdir(), 'brust-new-parent-'))
  const projectDir = path.join(parent, 'test-app')
  let proc: ReturnType<typeof spawn> | undefined
  const port = 38292

  try {
    // 1. Scaffold
    const scaffold = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} new test-app --dir ${projectDir}`.nothrow()
    expect(scaffold.exitCode).toBe(0)

    // 2. File tree
    expect(existsSync(path.join(projectDir, 'package.json'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'tsconfig.json'))).toBe(true)
    expect(existsSync(path.join(projectDir, '.gitignore'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'index.ts'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'routes.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'island.config.ts'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'app.css'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'README.md'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'pages/Home.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'components/Layout.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'components/Counter.tsx'))).toBe(true)
    // No .tmpl leaks
    expect(existsSync(path.join(projectDir, 'package.json.tmpl'))).toBe(false)
    expect(existsSync(path.join(projectDir, 'pages/Home.tsx.tmpl'))).toBe(false)
    expect(existsSync(path.join(projectDir, '_gitignore'))).toBe(false)

    // 3. package.json content
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('test-app')
    expect(pkg.dependencies.brust).toMatch(/^file:/)
    const brustPath = pkg.dependencies.brust.slice('file:'.length)
    expect(existsSync(path.join(brustPath, 'Cargo.toml'))).toBe(true)
    expect(pkg.scripts.dev).toBe('brust dev')
    expect(pkg.scripts.build).toBe('brust build')

    // 4. No substitution leakage
    const allFiles = await collectFiles(projectDir)
    for (const f of allFiles) {
      const content = await readFile(f, 'utf8').catch(() => '')
      expect(content, `placeholder leaked in ${f}`).not.toContain('__PROJECT_NAME__')
      expect(content, `placeholder leaked in ${f}`).not.toContain('__BRUST_DEP__')
    }

    // 5. bun install
    const install = await $`bun install`.cwd(projectDir).nothrow()
    expect(install.exitCode).toBe(0)

    // 6. bun run dev
    proc = spawn({
      cmd: ['bun', 'run', 'dev'],
      cwd: projectDir,
      env: { ...process.env, BRUST_PORT: String(port), BRUST_WORKERS: '1', RUST_LOG: 'brust=warn' },
      stdout: 'pipe',
      stderr: 'inherit',
    })
    await waitForPort(port, 15_000)

    // 7. curl /
    const home = await fetch(`http://127.0.0.1:${port}/`)
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('Welcome to brust')
  } finally {
    if (proc) {
      proc.kill('SIGINT')
      await proc.exited
    }
    await rm(parent, { recursive: true, force: true })
  }
}, 120_000)

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...await collectFiles(p))
    else if (ent.isFile()) out.push(p)
  }
  return out
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`)
      if (r.ok) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(`port ${port} never came up within ${timeoutMs}ms`)
}
```

- [ ] **Step 2: Run, confirm failure**

Run: `bun test tests/cli-new.test.ts -t 'brust new:'`
Expected: failures (case 'new' not wired, runNew not implemented).

- [ ] **Step 3: Implement `runNew`**

Replace the `runNew` body in `runtime/cli/new.ts`:

```ts
import { rm } from 'node:fs/promises'

const TEMPLATE_DIR = join(import.meta.dir, 'templates', 'minimal')

export async function runNew(args: string[]): Promise<void> {
  let parsed: ParsedNewArgs
  try {
    parsed = parseArgs(args)
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  const { projectName, targetDir } = parsed

  // Empty-dir check; remember whether we created it so cleanup is bounded.
  const targetExisted = existsSync(targetDir)
  if (targetExisted) {
    const entries = await readdir(targetDir)
    if (entries.length > 0) {
      console.error(`brust new: target directory "${targetDir}" is not empty`)
      process.exit(1)
    }
  }

  let brustRef: BrustRef
  try {
    brustRef = resolveBrustRef()
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  try {
    await copyTemplate({
      templateDir: TEMPLATE_DIR,
      targetDir,
      substitutions: {
        __PROJECT_NAME__: projectName,
        __BRUST_DEP__: JSON.stringify(brustRef.spec),
      },
    })
  } catch (e) {
    // Best-effort cleanup ONLY if we created the directory.
    if (!targetExisted) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    }
    console.error(`brust new: failed to scaffold (${e instanceof Error ? e.message : String(e)})`)
    process.exit(1)
  }

  printNextSteps(projectName, targetDir)
}

function printNextSteps(name: string, targetDir: string): void {
  const cwd = process.cwd()
  const displayPath = targetDir.startsWith(cwd + '/')
    ? './' + targetDir.slice(cwd.length + 1)
    : targetDir
  console.log(`Created ${name} at ${targetDir}\n`)
  console.log(`Next:`)
  console.log(`  cd ${displayPath}`)
  console.log(`  bun install`)
  console.log(`  bun run dev`)
}
```

- [ ] **Step 4: Wire CLI dispatcher**

Edit `runtime/cli/index.ts`. Add `case 'new'` after the existing `case 'dev'`:

```ts
  case 'new': {
    const { runNew } = await import('./new.ts')
    await runNew(rest)
    break
  }
```

And update the default error messages to mention `new`:

```ts
    if (!subcommand) {
      console.error('brust: missing subcommand. Try: brust build | brust dev | brust new')
    } else {
      console.error(`brust: unknown subcommand "${subcommand}". Try: brust build | brust dev | brust new`)
    }
```

- [ ] **Step 5: Run integration tests**

Run: `bun test tests/cli-new.test.ts`
Expected: all unit + integration tests pass (4 of them are the new integration tests; the rest from earlier tasks). Total ~16 tests.

If the heavy test (#4 happy-path) fails on `bun install`, debug:
  - Check that `bun install` from the scaffolded project finds the file: ref
  - If brust's own native module isn't symlinked, check `runtime/runtime.binding.target` resolution

If it fails on `bun run dev`, check the `bin` field in root package.json resolves the `brust` script.

- [ ] **Step 6: Verify existing suites still green**

Run: `bun test tests/cli-build.test.ts`
Expected: 7 pass.

Run: `bun test runtime/`
Expected: 188 pass.

- [ ] **Step 7: Commit**

```bash
git add runtime/cli/new.ts runtime/cli/index.ts tests/cli-new.test.ts
git commit -m "feat(cli): brust new <name> ships

Scaffolds a working brust app from runtime/cli/templates/minimal:
parses args, validates target dir, resolves the brust dep ref
(file: when run from source, version range otherwise), copies the
template with substitutions, prints next-steps. Best-effort cleanup
on mid-copy failure.

Integration test covers scaffold → bun install → bun run dev →
curl / → 200 with 'Welcome to brust'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Update architecture.md

**Files:**
- Modify: `architecture.md`

- [ ] **Step 1: Find the Built list in architecture.md**

Run: `grep -n "Built" architecture.md | head -20`

Locate the "Built" subsection (the bulleted list of shipped features). Add a new bullet at the end of that list.

- [ ] **Step 2: Add bullet**

Use Edit to insert under the Built list:

```markdown
- **`brust new` scaffolding** — `brust new <name>` creates a fresh project at `./<name>/` (or `--dir <path>`) from `runtime/cli/templates/minimal/`. Single template: TypeScript + Tailwind v4 + one hydrated island. When the CLI runs from the brust source tree, the emitted `package.json` references brust via `file:<repo>` so the scaffolded project installs and boots end-to-end. The validation test exercises the full scaffold → `bun install` → `bun run dev` → curl flow.
```

(Place after the most recent Built bullet — likely the Component CSS one. Match the indentation/style of surrounding bullets.)

- [ ] **Step 3: Commit**

```bash
git add architecture.md
git commit -m "docs(architecture): brust new scaffolding shipped

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Plan task |
|---|---|
| CLI surface (`brust new <name> [--dir <path>]`) | Task 4 + Task 7 |
| Project name validation | Task 4 |
| Empty-dir check | Task 7 |
| Best-effort cleanup | Task 7 (step 3) |
| Template emission with substitution | Task 6 |
| `_gitignore` rename | Task 6 |
| Brust ref resolution (file: vs version) | Task 5 |
| Static template files | Task 2 |
| Substituted template files | Task 3 |
| CLI dispatcher wiring | Task 7 (step 4) |
| Test #1 — happy path | Task 7 (step 1, #4) |
| Test #2 — `--dir .` | NOT covered explicitly. The `--dir` mechanism is covered by Task 4 parseArgs tests + Task 7 integration test (`--dir <tmpparent>/test-app`). Skipping a dedicated `.` test because chdir-based tests are flaky and the resolve logic is identical. |
| Test #3 — non-empty dir | Task 7 |
| Test #4 — invalid name | Task 4 (unit) + Task 7 (integration) |
| Test #5 — missing name | Task 4 (unit) + Task 7 (integration) |
| Test #6 — substitution leakage | Task 7 |
| React peer-deps move | Task 1 |
| `exports` map | Task 1 |
| architecture.md bullet | Task 8 |

All spec sections covered. The `--dir .` case is consciously skipped — note added above.

**Placeholder scan:** no "TBD", "TODO", "fill in later" in the plan body. All tasks have concrete code blocks.

**Type consistency:** `ParsedNewArgs` (Task 4) reused unchanged in Task 7. `BrustRef` (Task 5) referenced in Task 7. `CopyTemplateOpts` (Task 6) used in Task 7. `parseArgs` throws plain `Error`; the integration tests use stderr matching for end-to-end, the unit tests use `toThrow(/regex/)` — consistent both ways. Names match across tasks (no `parseNewArgs` vs `parseArgs` drift).
