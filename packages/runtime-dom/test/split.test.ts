// Core + feature modules (L33, R35.1): the core knows no directive by name, each feature is its own file that
// imports the core's API from one shared core module, and a feature never drags core code into itself.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { BUDGET_FILE, bundle, measure } from '../scripts/size'

const FEATURES = ['basics', 'if', 'for', 'model', 'html', 'island'] as const

test('the core binds no directive by name and carries no island or store glue', async () => {
  const core = await bundle('core.ts', false)
  // the walker names x-for / x-if / x-html (structural ownership, inert markup); no binder is named
  for (const attr of ['x-text', 'x-show', 'x-ref', 'x-model']) expect(core.includes(`"${attr}"`), attr).toBe(false)
  expect(core.includes('brust-island[data-id]')).toBe(false)
  expect(core.includes('data-brust-store')).toBe(false)
})

test('each feature imports the core API from the shared core module and bundles no core code', async () => {
  const core = await bundle('core.ts', false)
  for (const f of FEATURES) {
    const js = await bundle(`features/${f}.ts`, true)
    expect(js, f).toMatch(/from"\.\/core\.js"/)
    expect(js.includes('init threw'), f).toBe(false)   // mount.ts stays in the core
    expect(js.length, f).toBeLessThan(core.length)
  }
})

test('basics carries text/show/bind/on/ref; if, for, model, html each carry only their own binder', async () => {
  const has = async (f: string, attr: string) => (await bundle(`features/${f}.ts`, true)).includes(`"${attr}"`)
  for (const a of ['x-text', 'x-show', 'x-ref']) expect(await has('basics', a), a).toBe(true)
  for (const [f, a] of [['if', 'x-if'], ['for', 'x-for'], ['model', 'x-model'], ['html', 'x-html']] as const) {
    expect(await has(f, a), f).toBe(true)
    expect(await has('basics', a), `basics must not carry ${a}`).toBe(false)
  }
})

test('size budget: core and every feature stay within docs/runtime-budget.json (gzip)', async () => {
  const s = await measure()
  const b = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as { core: number; features: Record<string, number> }
  console.log(`[runtime-split] core ${s.core} B gz, ${Object.entries(s.features).map(([f, n]) => `${f} ${n}`).join(', ')}`)
  expect(s.core, 'core grew: raise docs/runtime-budget.json with a reason').toBeLessThanOrEqual(b.core)
  for (const [f, n] of Object.entries(s.features)) expect(n, `${f} grew: raise docs/runtime-budget.json with a reason`).toBeLessThanOrEqual(b.features[f]!)
})
