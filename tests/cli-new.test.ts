import { test, expect } from 'bun:test'
import { parseArgs, resolveBrustRef, copyTemplate, selectTemplate } from '../runtime/cli/new.ts'
import {
  listTemplates,
  getTemplate,
  findBrustPackageRoot,
  DEFAULT_TEMPLATE,
} from '../runtime/cli/templates.ts'
import path from 'node:path'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { $ } from 'bun'
import { existsSync } from 'node:fs'

const REPO = path.resolve(import.meta.dir, '..')

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
  await expect(
    copyTemplate({
      templateDir: '/no/such/dir',
      targetDir: '/tmp/whatever',
      substitutions: {},
    }),
  ).rejects.toThrow(/template directory/)
})

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
    const result =
      await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} new test --dir ${dir}`.nothrow()
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('not empty')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Scaffold-output verification. End-to-end boot (`bun install` + `bun run dev`
// or `bun run dist/index.js`) is deferred: see the "Known limitations" section
// of docs/superpowers/specs/2026-05-27-brust-new-scaffolding-design.md — the
// dual-React copy caused by Bun's `file:` install symlinking individual source
// files back to the brust repo makes both dev and build modes fail SSR. Fix is
// a workspace restructure of the brust repo, tracked as a follow-up.
test('brust new: scaffold emits the expected tree and content', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'brust-new-parent-'))
  const projectDir = path.join(parent, 'test-app')

  try {
    const scaffold =
      await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} new test-app --dir ${projectDir}`.nothrow()
    expect(scaffold.exitCode).toBe(0)

    // File tree
    expect(existsSync(path.join(projectDir, 'package.json'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'tsconfig.json'))).toBe(true)
    expect(existsSync(path.join(projectDir, '.gitignore'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'index.ts'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'routes.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'island.config.ts'))).toBe(false)
    expect(existsSync(path.join(projectDir, 'app.css'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'README.md'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'pages/Home.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'components/Counter.tsx'))).toBe(true)
    // Static public asset ships in the scaffold (served at GET /favicon.svg).
    expect(existsSync(path.join(projectDir, 'public/favicon.svg'))).toBe(true)
    // Home is a native route showcasing islands — lock that contract so the
    // scaffold can't silently regress to a plain React page.
    expect(await readFile(path.join(projectDir, 'routes.tsx'), 'utf8')).toContain('native: true')
    expect(existsSync(path.join(projectDir, 'package.json.tmpl'))).toBe(false)
    expect(existsSync(path.join(projectDir, 'pages/Home.tsx.tmpl'))).toBe(false)
    expect(existsSync(path.join(projectDir, '_gitignore'))).toBe(false)

    // package.json shape
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('test-app')
    expect(pkg.dependencies.brustjs).toMatch(/^file:/)
    const brustPath = pkg.dependencies.brustjs.slice('file:'.length)
    expect(existsSync(path.join(brustPath, 'Cargo.toml'))).toBe(true)
    // tailwindcss is an opt-in *project* dependency (not bundled in brust core),
    // so the scaffold must declare it for `@import "tailwindcss"` to resolve.
    expect(pkg.dependencies.tailwindcss).toBeTruthy()
    expect(pkg.scripts.dev).toBe('brustjs dev')
    expect(pkg.scripts.build).toBe('brustjs build')

    // No substitution leakage in any emitted file.
    const allFiles = await collectFiles(projectDir)
    for (const f of allFiles) {
      const content = await readFile(f, 'utf8').catch(() => '')
      expect(content, `placeholder leaked in ${f}`).not.toContain('__PROJECT_NAME__')
      expect(content, `placeholder leaked in ${f}`).not.toContain('__BRUST_DEP__')
      // Guard the brust→brustjs rename: no import may reference the old bare
      // `brust` package (the published name is `brustjs`). `brustjs/...` is fine.
      expect(content, `stale 'brust' import in ${f}`).not.toMatch(/from ['"]brust(\/[^'"]*)?['"]/)
    }
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}, 30_000)

test('templates: listTemplates returns minimal + pokedex', () => {
  const names = listTemplates().map((t) => t.name)
  expect(names).toContain('minimal')
  expect(names).toContain('pokedex')
})

test('templates: DEFAULT_TEMPLATE resolves to a registered template (minimal)', () => {
  expect(DEFAULT_TEMPLATE).toBe('minimal')
  // Lock that the default name actually resolves in the registry, not just the constant value.
  expect(getTemplate(DEFAULT_TEMPLATE)?.name).toBe('minimal')
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
  // Build artifacts must never be scaffolded out of the dev tree.
  expect(t.exclude.has('.brust')).toBe(true)
  expect(t.exclude.has('dist')).toBe(true)
  expect(t.exclude.has('node_modules')).toBe(true)
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
  expect(pkg.dependencies.tailwindcss).toBeUndefined()
  expect(pkg.scripts.dev).toBe('brustjs dev')
})

test('findBrustPackageRoot: resolves this repo root (has Cargo.toml + example/pokedex)', () => {
  const root = findBrustPackageRoot()
  expect(root).toBe(REPO) // pin the exact dir — not just a coincidental layout match
  expect(existsSync(path.join(root, 'Cargo.toml'))).toBe(true)
  expect(existsSync(path.join(root, 'example/pokedex/routes.tsx'))).toBe(true)
})

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
test('parseArgs: --template= (empty) throws', () => {
  expect(() => parseArgs(['app', '--template='])).toThrow(/--template requires a value/)
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
  expect(() => selectTemplate({ explicit: 'nope', yes: false, isTTY: false })).toThrow(
    /unknown template/,
  )
})
test('selectTemplate: yes → default minimal', () => {
  expect(selectTemplate({ yes: true, isTTY: true }).name).toBe('minimal')
})
test('selectTemplate: non-TTY → default minimal', () => {
  expect(selectTemplate({ yes: false, isTTY: false }).name).toBe('minimal')
})
test('selectTemplate: TTY + read "2" → pokedex', () => {
  expect(selectTemplate({ yes: false, isTTY: true, read: () => '2', print: () => {} }).name).toBe(
    'pokedex',
  )
})
test('selectTemplate: TTY + read "" → default minimal', () => {
  expect(selectTemplate({ yes: false, isTTY: true, read: () => '', print: () => {} }).name).toBe(
    'minimal',
  )
})
test('selectTemplate: TTY + read name "pokedex" → pokedex', () => {
  expect(
    selectTemplate({ yes: false, isTTY: true, read: () => 'pokedex', print: () => {} }).name,
  ).toBe('pokedex')
})
test('selectTemplate: TTY + null reader → default minimal (no infinite loop)', () => {
  expect(selectTemplate({ yes: false, isTTY: true, read: () => null, print: () => {} }).name).toBe(
    'minimal',
  )
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
    expect(existsSync(path.join(target, 'sub/README.md'))).toBe(true)
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
    expect(await readFile(path.join(target, 'package.json'), 'utf8')).toBe('{"x":"__X__"}\n')
  } finally {
    await rm(tmpl, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  }
})

test('brust new --template pokedex: emits pokedex tree, no docs, synth package.json', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'brust-new-poke-'))
  const projectDir = path.join(parent, 'poke-app')
  try {
    const scaffold =
      await $`bun ${path.join(REPO, 'runtime/cli/index.ts')} new poke-app --template pokedex --dir ${projectDir} < /dev/null`.nothrow()
    expect(scaffold.exitCode).toBe(0)

    expect(existsSync(path.join(projectDir, 'routes.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'index.ts'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'actions.ts'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'app.css'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'pages/DetailPage.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'lib/loaders.ts'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'components/TeamBuilder.tsx'))).toBe(true)

    expect(existsSync(path.join(projectDir, 'FRAMEWORK-GAPS.md'))).toBe(false)
    expect(existsSync(path.join(projectDir, 'README.md'))).toBe(false)
    expect(existsSync(path.join(projectDir, '.brust'))).toBe(false)
    expect(existsSync(path.join(projectDir, 'dist'))).toBe(false)

    expect(existsSync(path.join(projectDir, 'tsconfig.json'))).toBe(true)
    expect(existsSync(path.join(projectDir, '.gitignore'))).toBe(true)
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('poke-app')
    expect(pkg.dependencies.brustjs).toMatch(/^file:/)
    expect(pkg.dependencies.zod).toBeTruthy()
    expect(pkg.dependencies['react-dom']).toBeTruthy()
    expect(pkg.dependencies.tailwindcss).toBeUndefined()
    expect(pkg.scripts.dev).toBe('brustjs dev')

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
    expect(existsSync(path.join(projectDir, 'pages/Home.tsx'))).toBe(true)
    expect(existsSync(path.join(projectDir, 'components/Counter.tsx'))).toBe(true)
    const pkg = JSON.parse(await readFile(path.join(projectDir, 'package.json'), 'utf8'))
    expect(pkg.dependencies.tailwindcss).toBeTruthy()
    expect(existsSync(path.join(projectDir, 'FRAMEWORK-GAPS.md'))).toBe(false)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}, 30_000)

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...(await collectFiles(p)))
    else if (ent.isFile()) out.push(p)
  }
  return out
}
