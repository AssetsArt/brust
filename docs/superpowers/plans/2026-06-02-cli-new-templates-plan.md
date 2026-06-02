# Plan — Interactive `brust new` with template selection

**Spec:** `docs/superpowers/specs/2026-06-02-cli-new-templates-design.md`
**Branch:** `feat/cli-new-templates` · base `7fa8067`

TDD throughout: write the failing test, run it red, implement, run green. Gates
per task: `bun test tests/cli-new.test.ts` and `bun run ci` (biome) clean on
changed TS. **No Rust changes.** Run all `bun` commands from repo root.

## Spec-coverage map

| Spec section | Task |
|---|---|
| Template registry, findBrustPackageRoot, pokedex extraFiles | Task A |
| parseArgs (+template/+yes), resolveBrustRef rewrite, copyTemplate (+exclude/+extraFiles), selectTemplate/promptPicker, runNew wiring | Task B |
| help.ts text, npm `files`, scaffold subprocess tests (pokedex + non-TTY default) | Task C |

---

## Task A — `runtime/cli/templates.ts` registry + tests

**Files:** create `runtime/cli/templates.ts`; edit `tests/cli-new.test.ts`.

### A1. Write tests first (append to `tests/cli-new.test.ts`)

Add these imports at the top (alongside the existing `new.ts` import):

```ts
import {
  listTemplates,
  getTemplate,
  findBrustPackageRoot,
  DEFAULT_TEMPLATE,
} from '../runtime/cli/templates.ts'
```

Append these tests:

```ts
test('templates: listTemplates returns minimal + pokedex', () => {
  const names = listTemplates().map((t) => t.name)
  expect(names).toContain('minimal')
  expect(names).toContain('pokedex')
})

test('templates: DEFAULT_TEMPLATE is minimal', () => {
  expect(DEFAULT_TEMPLATE).toBe('minimal')
})

test('templates: getTemplate known/unknown', () => {
  expect(getTemplate('pokedex')?.name).toBe('pokedex')
  expect(getTemplate('minimal')?.name).toBe('minimal')
  expect(getTemplate('bogus')).toBeUndefined()
})

test('templates: minimal sourceDir exists and has routes.tsx', () => {
  const t = getTemplate('minimal')!
  expect(existsSync(path.join(t.sourceDir, 'routes.tsx'))).toBe(true)
  expect(t.exclude.size).toBe(0)
  expect(t.extraFiles).toBeUndefined()
})

test('templates: pokedex sourceDir exists, has routes.tsx, excludes docs', () => {
  const t = getTemplate('pokedex')!
  expect(existsSync(path.join(t.sourceDir, 'routes.tsx'))).toBe(true)
  expect(t.exclude.has('FRAMEWORK-GAPS.md')).toBe(true)
  expect(t.exclude.has('README.md')).toBe(true)
  expect(typeof t.extraFiles).toBe('function')
})

test('templates: pokedex extraFiles synthesizes package.json/tsconfig/.gitignore', () => {
  const t = getTemplate('pokedex')!
  const files = t.extraFiles!({ projectName: 'demo', brustSpec: '^9.9.9' })
  const byPath = new Map(files.map((f) => [f.relPath, f.content]))
  expect(byPath.has('package.json')).toBe(true)
  expect(byPath.has('tsconfig.json')).toBe(true)
  expect(byPath.has('.gitignore')).toBe(true)
  const pkg = JSON.parse(byPath.get('package.json')!)
  expect(pkg.name).toBe('demo')
  expect(pkg.dependencies.brustjs).toBe('^9.9.9')
  expect(pkg.dependencies.zod).toBeTruthy()
  expect(pkg.dependencies['react-dom']).toBeTruthy()
  expect(pkg.dependencies.tailwindcss).toBeUndefined() // pokedex does NOT use tailwind
  expect(pkg.scripts.dev).toBe('brustjs dev')
})

test('findBrustPackageRoot: resolves this repo root (has Cargo.toml + example/pokedex)', () => {
  const root = findBrustPackageRoot()
  expect(existsSync(path.join(root, 'Cargo.toml'))).toBe(true)
  expect(existsSync(path.join(root, 'example/pokedex/routes.tsx'))).toBe(true)
})
```

Run red: `bun test tests/cli-new.test.ts` → fails to import `templates.ts`.

### A2. Implement `runtime/cli/templates.ts`

```ts
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface ScaffoldCtx {
  projectName: string
  /** Raw brust dep spec, e.g. "file:/abs/path" or "^0.1.16-alpha". */
  brustSpec: string
}

export interface EmittedFile {
  /** POSIX-relative destination path under the project root. */
  relPath: string
  content: string
}

export interface TemplateDef {
  name: string
  title: string
  description: string
  sourceDir: string
  /** POSIX-relative paths (from sourceDir) to skip when copying. */
  exclude: Set<string>
  /** Files the source tree lacks, generated at scaffold time. */
  extraFiles?: (ctx: ScaffoldCtx) => EmittedFile[]
}

export const DEFAULT_TEMPLATE = 'minimal'

const MINIMAL_DIR = join(import.meta.dir, 'templates', 'minimal')

/**
 * Walk up from `startDir` to the directory of the nearest package.json whose
 * `name === 'brustjs'`. This is the single source of truth for locating the
 * brust package root (consumed by both `resolveBrustRef` and pokedex template
 * resolution). Works in the source tree (repo root) and a published install
 * (`node_modules/brustjs`). Throws if no such package.json is found.
 */
export function findBrustPackageRoot(startDir: string = import.meta.dir): string {
  let dir = startDir
  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        if (pkg.name === 'brustjs') return dir
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

function pokedexExtraFiles(ctx: ScaffoldCtx): EmittedFile[] {
  // pokedex's dependency set differs from minimal: it uses `zod` and does NOT
  // use tailwind (its app.css is a hand-written design system). `react-dom` is
  // included as the framework's SSR/hydration peer (not a direct pokedex
  // import) — do not "tidy" it away.
  const pkg = {
    name: ctx.projectName,
    version: '0.0.1',
    private: true,
    type: 'module',
    scripts: {
      dev: 'brustjs dev',
      build: 'brustjs build',
    },
    dependencies: {
      brustjs: ctx.brustSpec,
      react: '^19.2.6',
      'react-dom': '^19.2.6',
      zod: '^4.4.3',
    },
    devDependencies: {
      '@types/bun': 'latest',
      '@types/react': '^19.2.15',
      '@types/react-dom': '^19.2.3',
      typescript: '^6.0.3',
    },
  }
  // tsconfig + .gitignore are identical to minimal's — reuse them as the single
  // source of truth rather than duplicating their content here.
  return [
    { relPath: 'package.json', content: `${JSON.stringify(pkg, null, 2)}\n` },
    { relPath: 'tsconfig.json', content: readFileSync(join(MINIMAL_DIR, 'tsconfig.json'), 'utf8') },
    { relPath: '.gitignore', content: readFileSync(join(MINIMAL_DIR, '_gitignore'), 'utf8') },
  ]
}

/**
 * Build the template registry fresh per call so a missing/corrupt install
 * surfaces as a thrown error at invocation time (not import time).
 */
export function listTemplates(): TemplateDef[] {
  const root = findBrustPackageRoot()
  return [
    {
      name: 'minimal',
      title: 'minimal',
      description: 'Minimal starter: native route + island counter',
      sourceDir: MINIMAL_DIR,
      exclude: new Set<string>(),
    },
    {
      name: 'pokedex',
      title: 'pokedex',
      description: 'Full PokéDex demo: native routes, loaders, islands, team store',
      sourceDir: join(root, 'example', 'pokedex'),
      // FRAMEWORK-GAPS.md + README.md are internal docs (per spec). .brust/dist/
      // node_modules are dev-tree build artifacts that must never be scaffolded.
      exclude: new Set(['FRAMEWORK-GAPS.md', 'README.md', '.brust', 'dist', 'node_modules']),
      extraFiles: pokedexExtraFiles,
    },
  ]
}

export function getTemplate(name: string): TemplateDef | undefined {
  return listTemplates().find((t) => t.name === name)
}
```

Run green: `bun test tests/cli-new.test.ts` (all Task-A tests pass). Then `bun run ci`.

**ESCALATE if:** `findBrustPackageRoot()` from `import.meta.dir` does NOT resolve to the repo root in the test (e.g. a stray `package.json` named `brustjs` shadows it). If so, report the resolved path; do not hack around it.

---

## Task B — `runtime/cli/new.ts` refactor + tests

**Files:** edit `runtime/cli/new.ts`, `tests/cli-new.test.ts`.

### B1. Write tests first (append to `tests/cli-new.test.ts`)

Add `selectTemplate` to the `new.ts` import. Then append:

```ts
// --- parseArgs: template + yes ---
test('parseArgs: --template pokedex', () => {
  expect(parseArgs(['app', '--template', 'pokedex']).template).toBe('pokedex')
})
test('parseArgs: --template=pokedex', () => {
  expect(parseArgs(['app', '--template=pokedex']).template).toBe('pokedex')
})
test('parseArgs: -t minimal', () => {
  expect(parseArgs(['app', '-t', 'minimal']).template).toBe('minimal')
})
test('parseArgs: --template without value throws', () => {
  expect(() => parseArgs(['app', '--template'])).toThrow(/--template requires a value/)
})
test('parseArgs: --yes / -y set yes', () => {
  expect(parseArgs(['app', '--yes']).yes).toBe(true)
  expect(parseArgs(['app', '-y']).yes).toBe(true)
})
test('parseArgs: yes defaults false, template undefined', () => {
  const r = parseArgs(['app'])
  expect(r.yes).toBe(false)
  expect(r.template).toBeUndefined()
})

// --- selectTemplate (injected read/isTTY) ---
test('selectTemplate: explicit valid name', () => {
  expect(selectTemplate({ explicit: 'pokedex', yes: false, isTTY: false }).name).toBe('pokedex')
})
test('selectTemplate: explicit invalid name throws', () => {
  expect(() => selectTemplate({ explicit: 'nope', yes: false, isTTY: false })).toThrow(/unknown template/)
})
test('selectTemplate: yes → default minimal', () => {
  expect(selectTemplate({ yes: true, isTTY: true }).name).toBe('minimal')
})
test('selectTemplate: non-TTY → default minimal', () => {
  expect(selectTemplate({ yes: false, isTTY: false }).name).toBe('minimal')
})
test('selectTemplate: TTY + read "2" → pokedex', () => {
  expect(selectTemplate({ yes: false, isTTY: true, read: () => '2', print: () => {} }).name).toBe('pokedex')
})
test('selectTemplate: TTY + read "" → default minimal', () => {
  expect(selectTemplate({ yes: false, isTTY: true, read: () => '', print: () => {} }).name).toBe('minimal')
})
test('selectTemplate: TTY + read name "pokedex" → pokedex', () => {
  expect(selectTemplate({ yes: false, isTTY: true, read: () => 'pokedex', print: () => {} }).name).toBe('pokedex')
})
test('selectTemplate: TTY + null reader → default minimal (no infinite loop)', () => {
  expect(selectTemplate({ yes: false, isTTY: true, read: () => null, print: () => {} }).name).toBe('minimal')
})

// --- copyTemplate: exclude + extraFiles ---
test('copyTemplate: exclude skips listed root files; nested same-name survives', async () => {
  const tmpl = await mkdtemp(path.join(tmpdir(), 'brust-excl-src-'))
  const target = await mkdtemp(path.join(tmpdir(), 'brust-excl-dst-'))
  try {
    await Bun.write(path.join(tmpl, 'README.md'), 'root readme\n')
    await Bun.write(path.join(tmpl, 'keep.txt'), 'keep\n')
    await Bun.write(path.join(tmpl, 'sub/README.md'), 'nested readme\n')
    await copyTemplate({
      templateDir: tmpl,
      targetDir: target,
      substitutions: {},
      exclude: new Set(['README.md']),
    })
    expect(existsSync(path.join(target, 'README.md'))).toBe(false)
    expect(existsSync(path.join(target, 'keep.txt'))).toBe(true)
    expect(existsSync(path.join(target, 'sub/README.md'))).toBe(true) // nested survives
  } finally {
    await rm(tmpl, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('copyTemplate: extraFiles written verbatim (no substitution)', async () => {
  const tmpl = await mkdtemp(path.join(tmpdir(), 'brust-extra-src-'))
  const target = await mkdtemp(path.join(tmpdir(), 'brust-extra-dst-'))
  try {
    await Bun.write(path.join(tmpl, 'a.txt'), 'a\n')
    await copyTemplate({
      templateDir: tmpl,
      targetDir: target,
      substitutions: { __X__: 'SUBBED' },
      extraFiles: [{ relPath: 'package.json', content: '{"x":"__X__"}\n' }],
    })
    // extraFiles content is NOT run through applySubstitutions:
    expect(await readFile(path.join(target, 'package.json'), 'utf8')).toBe('{"x":"__X__"}\n')
  } finally {
    await rm(tmpl, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})
```

Run red: `bun test tests/cli-new.test.ts`.

### B2. Implement `runtime/cli/new.ts`

Top imports — add:
```ts
import {
  DEFAULT_TEMPLATE,
  type EmittedFile,
  findBrustPackageRoot,
  listTemplates,
  type TemplateDef,
} from './templates.ts'
```
Remove the now-unused local `TEMPLATE_DIR` constant (line 5).

`ParsedNewArgs`:
```ts
export interface ParsedNewArgs {
  projectName: string
  targetDir: string
  template?: string
  yes: boolean
}
```

`parseArgs` — add `template`/`yes` locals and branches **before** the
`a.startsWith('-')` catch-all (so `-t`/`-y` aren't swallowed as unknown flags):

```ts
export function parseArgs(args: string[]): ParsedNewArgs {
  let name: string | undefined
  let dir: string | undefined
  let template: string | undefined
  let yes = false

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--dir') {
      dir = args[++i]
      if (!dir) throw new Error('brust new: --dir requires a value')
    } else if (a.startsWith('--dir=')) {
      dir = a.slice('--dir='.length)
    } else if (a === '--template' || a === '-t') {
      template = args[++i]
      if (!template) throw new Error('brust new: --template requires a value')
    } else if (a.startsWith('--template=')) {
      template = a.slice('--template='.length)
    } else if (a === '--yes' || a === '-y') {
      yes = true
    } else if (a.startsWith('-')) {
      throw new Error(`brust new: unknown flag "${a}"`)
    } else if (name === undefined) {
      name = a
    } else {
      throw new Error(`brust new: unexpected positional argument "${a}"`)
    }
  }
  // ... existing name validation block unchanged ...

  const cwd = process.cwd()
  const targetDir = dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : resolve(cwd, name)
  return { projectName: name, targetDir, template, yes }
}
```

`resolveBrustRef` — rewrite to consume `findBrustPackageRoot` (single walk),
keeping the `hasSourceMarkers` decision:
```ts
export function resolveBrustRef(startDir: string = import.meta.dir): BrustRef {
  const dir = findBrustPackageRoot(startDir)
  if (hasSourceMarkers(dir)) {
    return { kind: 'file', spec: `file:${dir}` }
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  return { kind: 'version', spec: `^${version}` }
}
```
(`hasSourceMarkers` stays as-is. `readFileSync`/`join` already imported.)

`CopyTemplateOpts` + `copyTemplate` + `copyDir` — add exclude/extraFiles:
```ts
export interface CopyTemplateOpts {
  templateDir: string
  targetDir: string
  substitutions: Record<string, string>
  exclude?: Set<string>
  extraFiles?: EmittedFile[]
}

export async function copyTemplate(opts: CopyTemplateOpts): Promise<void> {
  if (!existsSync(opts.templateDir)) {
    throw new Error(
      `brust new: template directory not found at ${opts.templateDir}; this is a brust installation bug`,
    )
  }
  await copyDir(opts.templateDir, opts.targetDir, opts.substitutions, opts.exclude ?? new Set(), '')
  for (const f of opts.extraFiles ?? []) {
    const dstPath = join(opts.targetDir, f.relPath)
    await mkdir(dirname(dstPath), { recursive: true })
    await writeFile(dstPath, f.content) // verbatim — no substitution
  }
}

async function copyDir(
  src: string,
  dst: string,
  subs: Record<string, string>,
  exclude: Set<string>,
  relBase: string,
): Promise<void> {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const ent of entries) {
    const relPath = relBase ? `${relBase}/${ent.name}` : ent.name
    if (exclude.has(relPath)) continue
    const srcPath = join(src, ent.name)
    const dstName = renameForEmit(ent.name)
    const dstPath = join(dst, dstName)
    if (ent.isDirectory()) {
      await copyDir(srcPath, dstPath, subs, exclude, relPath)
    } else if (ent.isFile()) {
      const isTmpl = ent.name.endsWith('.tmpl')
      if (isTmpl) {
        const raw = await readFile(srcPath, 'utf8')
        await writeFile(dstPath, applySubstitutions(raw, subs))
      } else {
        await writeFile(dstPath, await readFile(srcPath))
      }
    }
  }
}
```

`selectTemplate` + `promptPicker` — add (place after `copyTemplate`):
```ts
export interface SelectTemplateOpts {
  explicit?: string
  yes: boolean
  isTTY: boolean
  read?: (label: string) => string | null
  print?: (s: string) => void
}

export function selectTemplate(opts: SelectTemplateOpts): TemplateDef {
  const templates = listTemplates()
  if (opts.explicit !== undefined) {
    const t = templates.find((x) => x.name === opts.explicit)
    if (!t) {
      throw new Error(
        `brust new: unknown template "${opts.explicit}" — choose one of: ${templates
          .map((x) => x.name)
          .join(', ')}`,
      )
    }
    return t
  }
  if (opts.yes || !opts.isTTY) {
    return templates.find((t) => t.name === DEFAULT_TEMPLATE) ?? templates[0]!
  }
  const read = opts.read ?? ((label: string) => prompt(label))
  const print = opts.print ?? ((s: string) => process.stdout.write(s))
  return promptPicker(templates, read, print)
}

function promptPicker(
  templates: TemplateDef[],
  read: (label: string) => string | null,
  print: (s: string) => void,
): TemplateDef {
  const def = templates.find((t) => t.name === DEFAULT_TEMPLATE) ?? templates[0]!
  const defIndex = templates.indexOf(def) + 1
  for (let attempt = 0; attempt < 3; attempt++) {
    print('Select a template:\n')
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i]!
      print(`  ${i + 1}) ${t.name} — ${t.description}\n`)
    }
    const raw = read(`Template [${defIndex}]: `)
    if (raw === null) return def
    const input = raw.trim()
    if (input === '') return def
    const asNum = Number.parseInt(input, 10)
    if (!Number.isNaN(asNum) && asNum >= 1 && asNum <= templates.length) {
      return templates[asNum - 1]!
    }
    const byName = templates.find((t) => t.name === input)
    if (byName) return byName
    print(`Invalid selection "${input}". Try again.\n`)
  }
  return def // bounded: after 3 attempts, fall back to default (no infinite loop)
}
```

`runNew` — resolve template and thread exclude/extraFiles. Replace the body
from the `copyTemplate({...})` call onward, and add `selectTemplate` between
`resolveBrustRef` and the copy:
```ts
  let brustRef: BrustRef
  try {
    brustRef = resolveBrustRef()
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  let tmpl: TemplateDef
  try {
    tmpl = selectTemplate({
      explicit: parsed.template,
      yes: parsed.yes,
      isTTY: Boolean(process.stdin.isTTY),
    })
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  try {
    await copyTemplate({
      templateDir: tmpl.sourceDir,
      targetDir,
      substitutions: {
        __PROJECT_NAME__: projectName,
        __BRUST_DEP__: JSON.stringify(brustRef.spec),
      },
      exclude: tmpl.exclude,
      extraFiles: tmpl.extraFiles?.({ projectName, brustSpec: brustRef.spec }),
    })
  } catch (e) {
    if (!targetExisted) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => {})
    }
    console.error(`brust new: failed to scaffold (${e instanceof Error ? e.message : String(e)})`)
    process.exit(1)
  }

  printNextSteps(projectName, targetDir, tmpl.name)
```
(`parsed` is already in scope; keep the existing `const { projectName, targetDir } = parsed` destructure. `targetExisted` is already computed earlier — unchanged.)

`printNextSteps` — add template name to the created line:
```ts
function printNextSteps(name: string, targetDir: string, template: string): void {
  const cwd = process.cwd()
  const displayPath = targetDir.startsWith(`${cwd}/`)
    ? `./${targetDir.slice(cwd.length + 1)}`
    : targetDir
  console.log(`Created ${name} at ${targetDir} (template: ${template})\n`)
  console.log('Next:')
  console.log(`  cd ${displayPath}`)
  console.log('  bun install')
  console.log('  bun run dev')
}
```

Run green: `bun test tests/cli-new.test.ts` (Task A + B all pass, existing 12
parseArgs + resolveBrustRef + copyTemplate tests still pass). Then `bun run ci`.

**ESCALATE if:** the existing `resolveBrustRef` source-tree test fails after the
rewrite — that means `findBrustPackageRoot` resolves a different dir than the old
inline walk. Report both paths.

---

## Task C — help text, npm packaging, scaffold subprocess tests

**Files:** edit `runtime/cli/help.ts`, `package.json`, `tests/cli-new.test.ts`.

### C1. `help.ts` — update the `new` command entry

Find the `new` command object (`name: 'new'`, ~line 66). Update its `usage` and
options/description to document `--template`/`-t` and `--yes`/`-y`. Match the
existing structure of that file (read it first to mirror the option-rendering
shape). Required content:
- usage: `brust new <name> [--dir <path>] [--template <name>] [--yes]`
- `--template, -t <name>`: Template to scaffold (minimal | pokedex). Prompts if omitted on a TTY; defaults to minimal otherwise.
- `--yes, -y`: Skip the prompt; use the default template (minimal).

Verify: `bun test tests/help.test.ts` stays green (adjust the test only if it
asserts exact `new` help text — extend the assertion, don't weaken it).

### C2. `package.json` — ship `example/pokedex` in the tarball

In the `files` array, after the existing `runtime` entries, add:
```json
"example/pokedex",
"!example/pokedex/FRAMEWORK-GAPS.md",
"!example/pokedex/README.md",
"!example/pokedex/.brust",
"!example/pokedex/dist",
"!example/pokedex/node_modules"
```
Verify with `bun pm pack --dry-run 2>&1 | grep -E 'example/pokedex' | head -20`:
- `example/pokedex/routes.tsx`, `app.css`, `index.ts`, `pages/...`, `lib/...`, `components/...`, `actions.ts` are listed
- `example/pokedex/FRAMEWORK-GAPS.md` and `example/pokedex/README.md` are NOT listed

### C3. Scaffold subprocess tests (append to `tests/cli-new.test.ts`)

```ts
test('brust new --template pokedex: emits pokedex tree, no docs, synth package.json', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'brust-new-poke-'))
  const projectDir = path.join(parent, 'poke-app')
  try {
    const scaffold =
      await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} new poke-app --template pokedex --dir ${projectDir} < /dev/null`.nothrow()
    expect(scaffold.exitCode).toBe(0)

    // pokedex source files copied
    expect(existsSync(path.join(projectDir, 'routes.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'index.ts'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'actions.ts'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'app.css'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'pages/DetailPage.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'lib/loaders.ts'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'components/TeamBuilder.tsx'))).toBe(true)

    // excluded docs are NOT emitted
    expect(existsSync(path.join(projectDir, 'FRAMEWORK-GAPS.md'))).toBe(false)
    expect(existsSync(path.join(projectDir, 'README.md'))).toBe(false)

    // synthesized files
    expect(existsSync(path.join(projectDir, 'tsconfig.json'))).toBe(true)
    expect(existsSync(path.join(projectDir, '.gitignore'))).toBe(true)
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('poke-app')
    expect(pkg.dependencies.brustjs).toMatch(/^file:/)
    expect(pkg.dependencies.zod).toBeTruthy()
    expect(pkg.dependencies['react-dom']).toBeTruthy()
    expect(pkg.dependencies.tailwindcss).toBeUndefined()
    expect(pkg.scripts.dev).toBe('brustjs dev')

    // no placeholder leakage, no bare 'brust' import
    const allFiles = await collectFiles(projectDir)
    for (const f of allFiles) {
      const content = await readFile(f, 'utf8').catch(() => '')
      expect(content, `placeholder leaked in ${f}`).not.toContain('__PROJECT_NAME__')
      expect(content, `placeholder leaked in ${f}`).not.toContain('__BRUST_DEP__')
      expect(content, `stale 'brust' import in ${f}`).not.toMatch(/from ['"]brust(\/[^'"]*)?['"]/)
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}, 30_000)

test('brust new (no --template, stdin closed): defaults to minimal tree', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'brust-new-defmin-'))
  const projectDir = path.join(parent, 'def-app')
  try {
    const scaffold =
      await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} new def-app --dir ${projectDir} < /dev/null`.nothrow()
    expect(scaffold.exitCode).toBe(0)
    // minimal markers
    expect(existsSync(path.join(projectDir, 'pages/Home.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'components/Counter.tsx'))).toBe(true)
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'))
    expect(pkg.dependencies.tailwindcss).toBeTruthy() // minimal uses tailwind
    expect(existsSync(path.join(projectDir, 'FRAMEWORK-GAPS.md'))).toBe(false)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}, 30_000)
```

Run green: `bun test tests/cli-new.test.ts` (full file). Then `bun run ci`.

**ESCALATE if:** the pokedex subprocess scaffold copies a `.brust/` or `dist/`
dir (means the dev tree had build artifacts and the exclude didn't catch them) —
report which dir leaked. Do NOT delete the dev tree's artifacts to make it pass.

---

## Final gate (Task C end)

1. `bun test tests/cli-new.test.ts` — all green (existing + new).
2. `bun test tests/help.test.ts` — green.
3. `bun run ci` — biome clean.
4. `bun pm pack --dry-run` — pokedex source in, docs out.

No Rust touched; full release-gate baselines re-run by the orchestrator in Phase 6.
