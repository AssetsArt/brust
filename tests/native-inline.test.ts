import { beforeAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'bun'
import { directiveName } from '../runtime/native/build.ts'
import {
  type IslandCache,
  type NativeComponentEntry,
  resolveComponentContext,
} from '../runtime/islands/native-render.ts'

/** T9 / native-inline integration — proves inline + hook-fallback + Island
 * reconciliation end-to-end through the real `brust build`.
 *
 * Strategy: BUILD-ARTIFACT assertions only (no server spawned) to avoid the
 * known port-race flake. See native-island-ssr.test.ts for the server-level
 * counterpart.
 *
 * Fixtures:
 *   NativeInline.tsx — native page using:
 *     InlineBadge (pure, conditional prop → inlined)
 *     HookBadge   (useState → hook fallback → SsrComponent / comp_N slot)
 *     WrapCounter (pure wrapper that CONTAINS an Island(Counter) → inlined;
 *                  Counter is NOT imported by the page itself — reconcile must
 *                  pick it up from mergedImports / gatherComponentSources)
 *
 * Assertions:
 *   1. inlines pure component        — ibadge class + {% if %} in .jinja
 *   2. inlined has no factory entry  — InlineBadge/WrapCounter absent from components.json
 *   3. hook component falls back     — comp_N slot in .jinja + HookBadge in components.json
 *                                      + stderr carries HookBadge + useState
 *   4. island reconcile via merged   — islands.json present + contains "Counter"
 *                                      (even though NativeInline.tsx never imports Counter)
 */

const REPO_ROOT = resolve(import.meta.dir, '..')
const FIXTURE_DIR = resolve(REPO_ROOT, 'tests/fixtures/app')
// `brust build` emits jinja templates INTO the build output dir (dist/jinja),
// alongside islands/css/mcp, so a dist-only deploy ships them.
const JINJA_DIR = resolve(FIXTURE_DIR, 'dist/jinja')

let capturedStderr = ''

beforeAll(() => {
  // Pre-flight: build jsx-rustc binary (same as sibling test).
  const buildRustc = spawnSync({
    cmd: ['cargo', 'build', '-p', 'jsx-rust-compiler', '--bin', 'jsx-rustc'],
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (buildRustc.exitCode !== 0) {
    throw new Error(
      `cargo build -p jsx-rust-compiler --bin jsx-rustc failed (exit ${buildRustc.exitCode})`,
    )
  }

  // Run brust build against the fixture (same cmd + cwd as native-island-ssr.test.ts).
  const buildRes = spawnSync({
    cmd: ['bun', 'run', resolve(REPO_ROOT, 'runtime/cli/index.ts'), 'build', 'index.ts'],
    cwd: FIXTURE_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdoutStr = buildRes.stdout ? new TextDecoder().decode(buildRes.stdout) : ''
  const stderrStr = buildRes.stderr ? new TextDecoder().decode(buildRes.stderr) : ''
  capturedStderr = stderrStr

  if (buildRes.exitCode !== 0) {
    throw new Error(`brust build failed (exit ${buildRes.exitCode}):\n${stdoutStr}\n${stderrStr}`)
  }
}, 120_000)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJinja(): string {
  const p = resolve(JINJA_DIR, 'NativeInline.jinja')
  if (!existsSync(p)) {
    throw new Error(`NativeInline.jinja not found at ${p} — build may have not emitted it`)
  }
  return readFileSync(p, 'utf8')
}

function readComponentsJson(): string | null {
  const p = resolve(JINJA_DIR, 'NativeInline.components.json')
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

function readIslandsJson(): string | null {
  const p = resolve(JINJA_DIR, 'NativeInline.islands.json')
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

function readStaticEvalJinja(): string {
  const p = resolve(JINJA_DIR, 'NativeInline.jinja')
  if (!existsSync(p)) {
    throw new Error('NativeInline.jinja not found at ' + p)
  }
  return readFileSync(p, 'utf8')
}

function readStaticEvalComponentsJson(): string | null {
  const p = resolve(JINJA_DIR, 'NativeInline.components.json')
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

test('expands bounded static data and private helpers through the CLI path', () => {
  const jinja = readStaticEvalJinja()
  for (const marker of [
    'defaulted-helper',
    'explicit-helper',
    'snapshot',
    'workflow',
    'audit',
    'locked',
    'native',
    'alpha',
    'beta',
    'direct-one',
    'direct-two',
    'stroke-width="2.25"',
  ]) {
    expect(jinja.includes(marker), 'Expected NativeStaticEval.jinja to contain ' + marker).toBe(
      true,
    )
  }
  expect(capturedStderr.includes('NativeStaticEval')).toBe(false)

  const components = readStaticEvalComponentsJson()
  if (components !== null) {
    for (const component of ['NativeStaticEval', 'PrivatePanel', 'PrivateBadge']) {
      expect(components.includes('"' + component + '"')).toBe(false)
    }
  }
})

// ---------------------------------------------------------------------------
// Test 1: InlineBadge is inlined — ibadge class + Jinja conditional appear
// ---------------------------------------------------------------------------

test('inlines pure component', () => {
  const jinja = readJinja()

  expect(
    jinja.includes('class="ibadge"'),
    `Expected NativeInline.jinja to contain class="ibadge" (InlineBadge inlined).\nActual jinja:\n${jinja}`,
  ).toBe(true)

  expect(
    jinja.includes('{% if '),
    `Expected NativeInline.jinja to contain {% if %} (strong conditional lowered to Jinja).\nActual jinja:\n${jinja}`,
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// Test 2: Inlined components have no SSR slot / factory entry
// ---------------------------------------------------------------------------

test('inlined component has no SSR slot/factory entry', () => {
  const jinja = readJinja()
  const compJson = readComponentsJson()

  // InlineBadge was inlined — must NOT produce a comp_N slot referencing it.
  // (The jinja may have comp_N slots but they should be for HookBadge only.)
  // The clearest proof: components.json must NOT contain "InlineBadge" or "WrapCounter".
  if (compJson !== null) {
    expect(
      compJson.includes('"InlineBadge"'),
      `Expected components.json NOT to contain "InlineBadge" (it was inlined).\ncomponents.json:\n${compJson}\nNativeInline.jinja:\n${jinja}`,
    ).toBe(false)

    expect(
      compJson.includes('"WrapCounter"'),
      `Expected components.json NOT to contain "WrapCounter" (it was inlined).\ncomponents.json:\n${compJson}\nNativeInline.jinja:\n${jinja}`,
    ).toBe(false)
  }
  // If components.json is absent entirely, InlineBadge/WrapCounter are clearly
  // not factory entries — that is also a pass for this assertion.
})

// ---------------------------------------------------------------------------
// Test 3: HookBadge falls back to SSR slot
// ---------------------------------------------------------------------------

test('hook component falls back', () => {
  const jinja = readJinja()
  const compJson = readComponentsJson()

  // The jinja must carry a comp_N_html slot (regex comp_\d+_html).
  expect(
    /comp_\d+_html/.test(jinja),
    `Expected NativeInline.jinja to contain a comp_N_html slot for HookBadge fallback.\nActual jinja:\n${jinja}`,
  ).toBe(true)

  // components.json must exist and contain "HookBadge".
  expect(
    compJson !== null,
    `Expected NativeInline.components.json to exist (HookBadge falls back to SSR component).\nNativeInline.jinja:\n${jinja}`,
  ).toBe(true)

  if (compJson !== null) {
    expect(
      compJson.includes('"HookBadge"'),
      `Expected components.json to contain "HookBadge".\ncomponents.json:\n${compJson}`,
    ).toBe(true)
  }

  // Build stderr must mention HookBadge and the hook that caused the fallback.
  expect(
    capturedStderr.includes('HookBadge'),
    `Expected build stderr to mention "HookBadge".\nCaptured stderr:\n${capturedStderr}`,
  ).toBe(true)

  expect(
    capturedStderr.includes('useState'),
    `Expected build stderr to mention "useState" (the hook that caused fallback).\nCaptured stderr:\n${capturedStderr}`,
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// Test 4: Island inside inlined WrapCounter is reconciled via mergedImports
// ---------------------------------------------------------------------------

test('inlined island reconciles via merged imports', () => {
  const jinja = readJinja()
  const islandsJson = readIslandsJson()

  expect(
    islandsJson !== null,
    `Expected NativeInline.islands.json to exist (Counter Island inside WrapCounter must be reconciled).\nNativeInline.jinja:\n${jinja}`,
  ).toBe(true)

  if (islandsJson !== null) {
    expect(
      islandsJson.includes('"Counter"'),
      `Expected NativeInline.islands.json to contain "Counter" (Island inside inlined WrapCounter must be reconciled even though NativeInline.tsx never imports Counter directly).\nislands.json:\n${islandsJson}\nNativeInline.jinja:\n${jinja}`,
    ).toBe(true)

    // Bug fix: Island's propsPath must be remapped from WrapCounter's local
    // param name "c" to the call-site field name "count".
    const islands = JSON.parse(islandsJson) as Array<{ component?: string; propsPath?: string }>
    const counterEntry = islands.find((e) => e.component === 'Counter')
    expect(
      counterEntry !== undefined,
      `Expected an island entry with component "Counter" in islands.json.\nislands.json:\n${islandsJson}`,
    ).toBe(true)
    if (counterEntry !== undefined) {
      expect(
        counterEntry.propsPath,
        `Expected Counter island propsPath to be "count" (remapped from WrapCounter's local "c" through inline subst), but got "${counterEntry.propsPath}".\nislands.json:\n${islandsJson}`,
      ).toBe('count')
    }
  }
})

// ---------------------------------------------------------------------------
// Test 5: behavior component auto-injects x-data, and the injected name matches
// the built directive chunk filename (the F4 single-name contract).
//
// NativeInline.tsx inlines <BehaviorBadge native/>. BehaviorBadge has
// `export const behavior` and the author wrote NO literal x-data, so the
// compiler AUTO-INJECTS `x-data="behaviorBadge_<8hex>"` onto its root element.
// The injected value MUST equal the built `<name>.directive.js` chunk filename
// or the runtime fetches a 404. The name is path-hashed against the BUILD cwd
// (FIXTURE_DIR — the build above runs with cwd: FIXTURE_DIR), so we recompute it
// with the same projectRoot rather than hard-coding the hash.
// ---------------------------------------------------------------------------

test('behavior component auto-injects x-data whose name matches its built chunk', () => {
  const jinja = readJinja()

  const expectedName = directiveName(
    resolve(FIXTURE_DIR, 'components/BehaviorBadge.tsx'),
    FIXTURE_DIR,
  )
  expect(expectedName).toMatch(/^behaviorBadge_[0-9a-f]{8}$/)

  // The author wrote no literal x-data — the compiler injected the path-hashed one
  // on BehaviorBadge's inlined root element (the <span class="bbadge">).
  expect(
    jinja.includes(`x-data="${expectedName}"`),
    `Expected NativeInline.jinja to contain auto-injected x-data="${expectedName}" on the inlined BehaviorBadge root.\nActual jinja:\n${jinja}`,
  ).toBe(true)

  // F4 cross-check: the injected x-data name MUST have a matching built chunk in
  // the served islands dir, or the runtime <name>.directive.js fetch 404s.
  const chunkPath = resolve(FIXTURE_DIR, 'dist/islands', `${expectedName}.directive.js`)
  expect(
    existsSync(chunkPath),
    `Expected directive chunk ${expectedName}.directive.js to exist at ${chunkPath} (F4 name contract: injected x-data must match a built chunk).`,
  ).toBe(true)

  // Belt-and-suspenders: no STALE non-matching x-data was injected (would mean a
  // path-normalization disagreement between scanDirectiveComponents and the
  // compiler's directiveNames map).
  const allXData = [...jinja.matchAll(/x-data="([a-zA-Z][a-zA-Z0-9]*_[0-9a-f]{8})"/g)].map(
    (m) => m[1],
  )
  for (const name of allXData) {
    expect(
      existsSync(join(FIXTURE_DIR, 'dist/islands', `${name}.directive.js`)),
      `Injected x-data="${name}" has NO matching ${name}.directive.js chunk — path normalization between scanDirectiveComponents and emitNativeTemplates disagree.`,
    ).toBe(true)
  }
})
test('behavior SSR fallback retains its canonical mount identity', async () => {
  const jinja = readJinja()
  const componentsJson = readComponentsJson()
  const expectedName = directiveName(
    resolve(FIXTURE_DIR, 'components/BehaviorSsrFallback.tsx'),
    FIXTURE_DIR,
  )

  expect(capturedStderr).toContain(
    'native component "BehaviorSsrFallback" not inlined: unsupported prop',
  )
  expect(componentsJson).not.toBeNull()

  const manifest = JSON.parse(componentsJson ?? '[]') as NativeComponentEntry[]
  const entry = manifest.find((candidate) => candidate.component === 'BehaviorSsrFallback')
  expect(entry).toBeDefined()
  expect(jinja).toContain(`comp_${entry?.instance}_html`)
  expect(existsSync(resolve(FIXTURE_DIR, 'dist/islands', `${expectedName}.directive.js`))).toBe(
    true,
  )

  const stored = new Map<string, { html: string; props: string }>()
  const cache: IslandCache = {
    get: (key) => stored.get(key) ?? null,
    set: (key, _tags, _ttlMs, html, props) => {
      stored.set(key, { html, props })
    },
  }

  const context = await resolveComponentContext(
    manifest,
    { label: 'Hi', strong: true, count: { start: 0, label: 'c' } },
    'NativeInline',
    JINJA_DIR,
    cache,
  )
  const rendered = context[`comp_${entry?.instance}_html`] ?? ''
  expect(rendered).toContain('class="behavior-ssr-fallback"')
  expect(rendered).toContain('x-on-click="activate"')
  expect(rendered).toContain(`x-data="${expectedName}"`)
  expect(rendered).toContain('C')
  expect(rendered).toContain('source-preserved')
  expect(stored.get('behavior-fallback')?.html).toBe(rendered)

  const cached = await resolveComponentContext(
    manifest,
    { label: 'changed', strong: false, count: { start: 9, label: 'changed' } },
    'NativeInline',
    JINJA_DIR,
    cache,
  )
  expect(cached[`comp_${entry?.instance}_html`]).toBe(rendered)
})

test('bounded Array.from length map inline-lowers without a fallback warning', () => {
  const jinja = readJinja()
  expect(jinja).toContain('class="static-array-from"')
  const first = jinja.indexOf('{{ (0) | e }}')
  const second = jinja.indexOf('{{ (1) | e }}')
  expect(first).toBeGreaterThanOrEqual(0)
  expect(second).toBeGreaterThan(first)
  expect(capturedStderr).not.toContain(
    'native component "BehaviorSsrFallback" not inlined: inline lowering cannot translate `from`',
  )
  const componentsJson = readComponentsJson()
  expect(componentsJson ?? '').toContain('"BehaviorSsrFallback"')
})
