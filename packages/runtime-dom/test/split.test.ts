// Core + feature modules (L33, R35.1): the core knows no directive by name, each feature is its own file that
// imports the core's API from one shared core module, and a feature never drags core code into itself.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const src = resolve(import.meta.dir, '../src')
const FEATURES = ['basics', 'if', 'for', 'model', 'html', 'island'] as const

async function bundle(entry: string, coreExternal: boolean): Promise<string> {
  const r = await Bun.build({
    entrypoints: [resolve(src, entry)], minify: true, format: 'esm', target: 'browser', define: { __BRUST_DEV__: 'false' },
    plugins: coreExternal ? [{ name: 'core-external', setup: (b) => { b.onResolve({ filter: /core-api$/ }, () => ({ path: './core.js', external: true })) } }] : [],
  })
  expect(r.success).toBe(true)
  return await r.outputs[0]!.text()
}

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

test('size budget: core plus basics stays well under the monolith (gzip, per file)', async () => {
  const gz = async (e: string, ext: boolean) => gzipSync(await bundle(e, ext), { level: 9 }).length
  const core = await gz('core.ts', false), basics = await gz('features/basics.ts', true)
  console.log(`[runtime-split] core ${core} B gz, basics ${basics} B gz`)
  expect(core).toBeLessThan(4200)
  expect(basics).toBeLessThan(1500)
})
