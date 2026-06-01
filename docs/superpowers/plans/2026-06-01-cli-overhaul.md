# Implementation plan — CLI overhaul (help/version + build --target)

Spec: `docs/superpowers/specs/2026-06-01-cli-overhaul-design.md`
Parent commit: `5bfeea1` · Area: `runtime/cli/`

Two tasks. Task 1 builds the CLI shell (`help.ts` + rewritten `index.ts`) and is
independent. Task 2 implements `build --target`. The `help.ts` COMMANDS registry
(Task 1) already DOCUMENTS `build --target` so the help text describes the final
state; Task 2 makes it real.

Verification (run from repo root):
- `bun test runtime/cli/help.test.ts` / `bun test runtime/cli/build.test.ts` — unit (gated via `bun test runtime/`)
- `bun test tests/cli-build.test.ts` — integration (local-only; run ISOLATED)
- `bunx biome check <touched files>` — lint gate (`biome check .` is CI)

---

## Task 1 — CLI shell: `help.ts` + rewrite `index.ts`

ESCALATE if: `import.meta.dir`-relative `../../package.json` does NOT resolve to
the brustjs package.json when the bin runs (the reviewer confirmed it does — but
verify at your own command line before trusting).

### Step 1.1 (GREEN) — create `runtime/cli/help.ts`

Create `runtime/cli/help.ts` with EXACTLY this content:

```ts
// Dep-free CLI help/version rendering + a tiny ANSI color util. All functions
// return strings (no console writes) so they're unit-testable. index.ts owns
// the actual stdout/stderr + exit codes.
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Read the brustjs package.json version. `help.ts` lives at
 * <root>/runtime/cli/, so ../../package.json is <root>/package.json in both the
 * source tree and an installed node_modules/brustjs layout. Never throws —
 * returns "unknown" on any failure (version must not crash the CLI). */
export function readVersion(): string {
  try {
    const p = path.join(import.meta.dir, '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(p, 'utf8')) as { version?: string }
    return pkg.version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// Color only when writing to a TTY and NO_COLOR is unset (checked at call time
// so tests — which pipe — get plain output).
function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
}
function wrap(open: string, s: string): string {
  return useColor() ? `\x1b[${open}m${s}\x1b[0m` : s
}
export const style = {
  bold: (s: string) => wrap('1', s),
  dim: (s: string) => wrap('2', s),
  cyan: (s: string) => wrap('36', s),
  green: (s: string) => wrap('32', s),
  red: (s: string) => wrap('31', s),
}

interface CommandDef {
  name: string
  summary: string
  usage: string
  flags: { flag: string; desc: string }[]
}

export const COMMANDS: CommandDef[] = [
  {
    name: 'build',
    summary: 'Compile a brust app to a self-contained dist/',
    usage: 'brust build [entry] [options]',
    flags: [
      { flag: '[entry]', desc: 'Entry file (default ./index.ts)' },
      { flag: '--out-dir <dir>', desc: 'Output directory (default ./dist)' },
      {
        flag: '--target <t>',
        desc: 'Native target(s): auto | all | <platform>-<arch>[-<libc>][,…] (default auto)',
      },
    ],
  },
  {
    name: 'dev',
    summary: 'Run the dev server with hot reload',
    usage: 'brust dev [entry] [options]',
    flags: [
      { flag: '[entry]', desc: 'Entry file (default ./index.ts)' },
      { flag: '--port <n>', desc: 'Port to listen on' },
    ],
  },
  {
    name: 'new',
    summary: 'Scaffold a new brust project',
    usage: 'brust new <name> [options]',
    flags: [
      { flag: '<name>', desc: 'Project name (lowercase letters, digits, - _)' },
      { flag: '--dir <path>', desc: 'Target directory (default ./<name>)' },
    ],
  },
]

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - s.length))
}

export function renderVersion(): string {
  return `brustjs ${readVersion()}`
}

export function renderRootHelp(): string {
  const lines: string[] = []
  lines.push(`${style.bold('brust')} ${style.dim(readVersion())} — the brust framework CLI`)
  lines.push('')
  lines.push(`${style.bold('Usage:')} brust <command> [options]`)
  lines.push('')
  lines.push(style.bold('Commands:'))
  const w = Math.max(...COMMANDS.map((c) => c.name.length))
  for (const c of COMMANDS) {
    lines.push(`  ${style.cyan(pad(c.name, w))}  ${c.summary}`)
  }
  lines.push('')
  lines.push(style.bold('Global:'))
  lines.push(`  ${style.cyan(pad('-h, --help', w + 2))}  Show help (brust help <command> for details)`)
  lines.push(`  ${style.cyan(pad('-v, --version', w + 2))}  Show the brustjs version`)
  lines.push('')
  lines.push(style.dim('Run `brust help <command>` for command-specific options.'))
  return lines.join('\n')
}

export function renderCommandHelp(name: string): string | null {
  const c = COMMANDS.find((x) => x.name === name)
  if (!c) return null
  const lines: string[] = []
  lines.push(`${style.bold('Usage:')} ${c.usage}`)
  lines.push('')
  lines.push(c.summary)
  lines.push('')
  lines.push(style.bold('Options:'))
  const w = Math.max(...c.flags.map((f) => f.flag.length))
  for (const f of c.flags) {
    lines.push(`  ${style.cyan(pad(f.flag, w))}  ${f.desc}`)
  }
  return lines.join('\n')
}
```

### Step 1.2 (GREEN) — rewrite `runtime/cli/index.ts`

Replace the whole file with:

```ts
#!/usr/bin/env bun
import { renderCommandHelp, renderRootHelp, renderVersion } from './help.ts'

const argv = process.argv.slice(2)
const [first, second, ...restAfterSecond] = argv

const KNOWN = new Set(['build', 'dev', 'new'])

function hasHelpFlag(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h')
}

// 1. version
if (first === '--version' || first === '-v' || first === 'version') {
  console.log(renderVersion())
  process.exit(0)
}

// 2. help (global or per-command)
if (first === '--help' || first === '-h' || first === 'help') {
  if (second && KNOWN.has(second)) {
    console.log(renderCommandHelp(second))
    process.exit(0)
  }
  if (second) {
    // help <unknown>
    console.error(`brust: unknown command "${second}".`)
    console.error(renderRootHelp())
    process.exit(1)
  }
  console.log(renderRootHelp())
  process.exit(0)
}

// 3. subcommand
if (first && KNOWN.has(first)) {
  const rest = argv.slice(1)
  if (hasHelpFlag(rest)) {
    console.log(renderCommandHelp(first))
    process.exit(0)
  }
  switch (first) {
    case 'build': {
      const { runBuild } = await import('./build.ts')
      await runBuild(rest)
      break
    }
    case 'dev': {
      const { runDev } = await import('./dev.ts')
      await runDev(rest)
      break
    }
    case 'new': {
      const { runNew } = await import('./new.ts')
      await runNew(rest)
      break
    }
  }
  // suppress unused-binding lints for the destructured tail
  void restAfterSecond
} else if (!first) {
  // 4. no command → usage error
  console.error(renderRootHelp())
  process.exit(1)
} else {
  // 5. unknown command
  console.error(`brust: unknown command "${first}".`)
  console.error(style_dimHint())
  process.exit(1)
}

function style_dimHint(): string {
  return 'Run `brust --help` to see available commands.'
}
```

NOTE: if the `void restAfterSecond` / `style_dimHint` helper trips biome
(e.g. function-hoist or unused), inline the hint string and drop the
`restAfterSecond` destructure (use `argv[1]` directly for `second`). Keep it
clean — the reviewer will check. Prefer the simplest form that biome accepts.

### Step 1.3 (RED→GREEN) — `runtime/cli/help.test.ts`

```ts
import { test, expect } from 'bun:test'
import {
  readVersion,
  renderVersion,
  renderRootHelp,
  renderCommandHelp,
} from './help.ts'
import pkg from '../../package.json'

test('readVersion matches package.json', () => {
  expect(readVersion()).toBe(pkg.version)
})

test('renderVersion contains the version', () => {
  expect(renderVersion()).toContain(pkg.version)
  expect(renderVersion()).toContain('brustjs')
})

test('renderRootHelp lists usage + all commands', () => {
  const h = renderRootHelp()
  expect(h).toContain('Usage')
  for (const name of ['build', 'dev', 'new']) expect(h).toContain(name)
  expect(h).toContain('--help')
  expect(h).toContain('--version')
})

test('renderCommandHelp(build) documents --target and --out-dir', () => {
  const h = renderCommandHelp('build')!
  expect(h).toContain('--target')
  expect(h).toContain('--out-dir')
})

test('renderCommandHelp(unknown) is null', () => {
  expect(renderCommandHelp('bogus')).toBeNull()
})

test('no ANSI escapes when not a TTY (test default)', () => {
  // bun:test runs with piped stdout → useColor() false.
  expect(renderRootHelp()).not.toContain('\x1b[')
  expect(renderCommandHelp('build')!).not.toContain('\x1b[')
})
```

(If `import pkg from '../../package.json'` needs an assertion, use
`with { type: 'json' }`; Bun accepts the bare form too — match what the repo's
other JSON imports do, else fall back to `readVersion()` cross-check.)

### Step 1.4 — update the stale integration assertion

`tests/cli-build.test.ts` ~line 118-120 currently:
```ts
const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')}`.nothrow()
expect(result.stderr.toString()).toContain('missing subcommand')
```
Replace the assertion with the new no-arg behavior (exit 1 + root help on stderr):
```ts
const result = await $`bun ${path.join(REPO, 'runtime/cli/index.ts')}`.nothrow()
expect(result.exitCode).not.toBe(0)
const err = result.stderr.toString()
expect(err).toContain('Usage')
expect(err).toContain('build')
```

### Step 1.5 — verify

```
bun test runtime/cli/help.test.ts
bun test tests/cli-build.test.ts        # isolated; the no-arg case + still-green build
bunx biome check runtime/cli/help.ts runtime/cli/index.ts runtime/cli/help.test.ts tests/cli-build.test.ts
```
Also smoke by hand: `bun runtime/cli/index.ts --version`, `… --help`, `… help build`,
`… frobnicate` (exit 1), `… | cat` (no ANSI). Commit: `feat(cli): help, version, and a polished dispatcher`.

---

## Task 2 — `build --target`

Depends on Task 1 committed (help.ts already documents `--target`).

### Step 2.1 (RED→GREEN) — `parseArgs` gains `--target`

`runtime/cli/build.ts`:
- Add `target: string` to `interface ParsedArgs`.
- In `parseArgs`, before the `a.startsWith('-')` catch-all, handle:
```ts
    } else if (a === '--target') {
      target = args[++i]
      if (!target) {
        console.error('brust build: --target requires a value')
        process.exit(1)
      }
    } else if (a.startsWith('--target=')) {
      target = a.slice('--target='.length)
```
- Declare `let target = 'auto'` near `let outDir`; return `target` in the result.

### Step 2.2 (RED→GREEN) — `selectNativeBinaries` (pure, exported)

Add to `build.ts` (export both `parseArgs`-relevant bits as needed for tests —
at minimum export `selectNativeBinaries` and a `hostTargetInfix()` helper):

```ts
/** The 6 published platform targets (root package.json optionalDependencies),
 * keyed by the napi binary infix `<platform>-<arch>[-<libc>]`. */
export const VALID_TARGETS = [
  'darwin-x64',
  'darwin-arm64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
] as const

/** Host target infix — reuses the same detection as platformPackageName by
 * stripping the `brustjs-` prefix. */
export function hostTargetInfix(): string {
  return platformPackageName().replace(/^brustjs-/, '')
}

function basenameTarget(absPath: string): string | null {
  const b = absPath.replace(/^.*[/\\]/, '') // basename
  const m = /^brust\.(.+)\.node$/.exec(b)
  return m ? m[1] : null
}

/** Select which collected `brust.*.node` paths to copy for `target`.
 * Pure: takes the collected absolute paths, returns selected paths + errors. */
export function selectNativeBinaries(
  collected: string[],
  target: string,
): { selected: string[]; errors: string[] } {
  const tokens = target
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  const byTarget = new Map<string, string>() // infix → first abs path (dedupe)
  for (const p of collected) {
    const t = basenameTarget(p)
    if (t && !byTarget.has(t)) byTarget.set(t, p)
  }

  if (tokens.length === 0) return { selected: [], errors: ['brust build: empty --target'] }

  const hasAuto = tokens.includes('auto')
  const hasAll = tokens.includes('all')
  if ((hasAuto || hasAll) && tokens.length > 1) {
    return { selected: [], errors: [`brust build: --target "${target}" — auto/all cannot be combined with other targets`] }
  }
  if (hasAll) return { selected: [...byTarget.values()], errors: [] }

  const wanted = hasAuto ? [hostTargetInfix()] : tokens
  const selected: string[] = []
  const errors: string[] = []
  for (const t of wanted) {
    if (!hasAuto && !VALID_TARGETS.includes(t as (typeof VALID_TARGETS)[number])) {
      errors.push(`brust build: unknown target "${t}" (valid: ${VALID_TARGETS.join(', ')}, or auto/all)`)
      continue
    }
    const p = byTarget.get(t)
    if (!p) {
      errors.push(`brust build: no native binary for target "${t}" — install brustjs-${t} or build it (bun --filter runtime run build)`)
      continue
    }
    selected.push(p)
  }
  return { selected, errors }
}
```

### Step 2.3 (GREEN) — honor target in `runBuild` copy loop

Replace the copy section (~288-313) so it selects via `selectNativeBinaries`:
```ts
  const nativeBinaries = await collectNativeBinaries()
  const { selected, errors } = selectNativeBinaries(nativeBinaries, args_target)
  if (errors.length > 0) {
    for (const e of errors) console.error(e)
    process.exit(1)
  }
  if (selected.length === 0) {
    console.error(
      `brust build: no native binary found for target "${args_target}". Looked in ` +
        `${path.join(REPO_ROOT, 'runtime')} and the ${platformPackageName()} package. ` +
        `From source run \`bun --filter runtime run build\` first.`,
    )
    process.exit(1)
  }
  const seen = new Set<string>()
  for (const src of selected) {
    const name = path.basename(src)
    if (seen.has(name)) continue
    seen.add(name)
    await copyFile(src, path.join(nativeDir, name))
    console.log(`[brust build] native:  ${name}`)
  }
```
Thread the parsed `target` into `runBuild` (it already destructures `parseArgs`
result — add `target` and pass as `args_target`). Keep the `[brust build]
native:` log per file unchanged.

### Step 2.4 (RED→GREEN) — `runtime/cli/build.test.ts`

```ts
import { test, expect } from 'bun:test'
import { selectNativeBinaries, hostTargetInfix, VALID_TARGETS } from './build.ts'

const FIX = ['/x/brust.darwin-arm64.node', '/x/brust.linux-x64-gnu.node']

test('all → every collected binary', () => {
  const { selected, errors } = selectNativeBinaries(FIX, 'all')
  expect(errors).toEqual([])
  expect(selected.sort()).toEqual([...FIX].sort())
})
test('explicit single target', () => {
  const { selected, errors } = selectNativeBinaries(FIX, 'darwin-arm64')
  expect(errors).toEqual([])
  expect(selected).toEqual(['/x/brust.darwin-arm64.node'])
})
test('explicit comma list', () => {
  const { selected } = selectNativeBinaries(FIX, 'linux-x64-gnu,darwin-arm64')
  expect(selected.length).toBe(2)
})
test('unknown target → error', () => {
  const { errors } = selectNativeBinaries(FIX, 'win32-x64')
  expect(errors.join()).toContain('unknown target')
})
test('valid but absent target → error', () => {
  const { errors } = selectNativeBinaries(FIX, 'linux-arm64-musl')
  expect(errors.join()).toContain('no native binary')
})
test('auto + all not combinable', () => {
  const { errors } = selectNativeBinaries(FIX, 'auto,all')
  expect(errors.length).toBeGreaterThan(0)
})
test('auto selects the host binary when present', () => {
  const host = hostTargetInfix()
  const fix = [`/x/brust.${host}.node`, '/x/brust.linux-x64-gnu.node']
  const { selected, errors } = selectNativeBinaries(fix, 'auto')
  expect(errors).toEqual([])
  expect(selected).toEqual([`/x/brust.${host}.node`])
})
test('VALID_TARGETS has the 6 published targets', () => {
  expect(VALID_TARGETS.length).toBe(6)
})
```
(Add `parseArgs` `--target` default/parse asserts only if `parseArgs` is
exported; it currently is NOT — keep it internal and cover via the integration
test, OR export it. Prefer exporting `parseArgs` for a direct
`parseArgs(['--target','all']).target === 'all'` test if it's low-risk.)

### Step 2.5 — README + integration smoke

- `README.md` (~line 75, the `brustjs build` mention): add a one-line note that
  `--target <auto|all|…>` selects the native binary (default `auto` = host).
- Integration: in `tests/cli-build.test.ts`, add a focused test that builds with
  `--target <hostInfix>` (compute `hostInfix` from `process.platform`/`arch` —
  do NOT hardcode) and asserts dist `native/` contains `brust.<hostInfix>.node`
  and only host-arch entries. Reuse the existing build harness.

### Step 2.6 — verify

```
bun test runtime/cli/build.test.ts
bun test tests/cli-build.test.ts        # isolated
bunx biome check runtime/cli/build.ts runtime/cli/build.test.ts README.md
```
Commit: `feat(build): --target to select native binary (default auto)`.

BLOCKED fallback: if exporting `parseArgs` causes churn (name clash with dev/new
tests importing it), keep `parseArgs` internal and cover `--target` parsing only
via `selectNativeBinaries` unit tests + the integration build.

---

## Spec coverage map

| Spec section | Task.Step |
|---|---|
| `help.ts` (readVersion/style/COMMANDS/render*) | 1.1 |
| `index.ts` rewrite (dispatch order 1–5) | 1.2 |
| help unit tests (1–3, color) | 1.3 |
| no-arg behavior change + test update | 1.2, 1.4 |
| `build --target` parse | 2.1 |
| `selectNativeBinaries` (auto/all/explicit/errors) | 2.2 |
| honor target on copy | 2.3 |
| build unit tests (4–5) | 2.4 |
| README `--target` | 2.5 |
| integration smoke (6–9, dynamic host) | 1.4, 2.5 |
| CI-gate note (logic in unit tests) | 1.3, 2.4 |
| Acceptance: biome clean, plain when piped | 1.5, 2.6 |
