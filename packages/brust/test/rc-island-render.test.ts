// F546 (R4, A3): the worker side of the `component` call's island renders: `components.render` is called for every asked
// pair whose ref is an island artifact (resolved in this call as tier 'island', or warm and not resolved here), once per
// key, in parallel, with `{ build, page: { id, total } }`; null / no method = html null; a throw or a non-string = error.
import { expect, test } from 'bun:test'
import { resolveComponents } from '../src/handlers'
import type { RuntimeComponents } from '../src/routes'

const island = (id: string) => ({ v: 1 as const, build: 'b1', id, tier: 'island' as const, client: '/* c */' })
const staticArt = { v: 1 as const, build: 'b1', id: 's', tier: 'static' as const, jinja: '<b>s</b>', client: null, features: [], stores: [] }

test('renders only island refs, once per key, with the page id and the batch total', async () => {
  const calls: Array<[string, unknown, unknown]> = []
  let inFlight = 0
  let peak = 0
  const components: RuntimeComponents = {
    resolve: (ref) => (ref === 'cold_island' ? island('isl_c') : ref === 'cold_static' ? staticArt : null),
    async render(ref, props, ctx) {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Bun.sleep(5)
      inFlight--
      calls.push([ref, props, ctx])
      return `<p>${ref}:${String(props.n)}</p>`
    },
  }
  const r = await resolveComponents(components, 'b1', {
    refs: ['cold_island', 'cold_static', 'gone'],
    page: 'pg1',
    renders: [
      { ref: 'cold_island', key: 'k1', props: { n: 1 } },
      { ref: 'cold_island', key: 'k1', props: { n: 1 } }, // same key: called once
      { ref: 'cold_static', key: 'k2', props: { n: 2 } }, // resolved static: not called
      { ref: 'gone', key: 'k3', props: {} }, // missing: not called
      { ref: 'warm_island', key: 'k4', props: { n: 4 } }, // not resolved here: the server knows it is an island
    ],
  })
  expect(r.results.map((x) => x.ref)).toEqual(['cold_island', 'cold_static', 'gone'])
  expect(r.html).toEqual([
    { ref: 'cold_island', key: 'k1', html: '<p>cold_island:1</p>' },
    { ref: 'warm_island', key: 'k4', html: '<p>warm_island:4</p>' },
  ])
  expect(calls.map((c) => { const { build, page } = c[2] as { build: string; page: unknown }; return { build, page } })).toEqual([
    { build: 'b1', page: { id: 'pg1', total: 2 } },
    { build: 'b1', page: { id: 'pg1', total: 2 } },
  ])
  expect(calls.every((c) => typeof (c[2] as { notNow?: unknown }).notNow === 'function')).toBe(true)
  expect(peak).toBe(2) // in parallel
})

test('null or no render method is html null; a throw or a non-string is that pair error only', async () => {
  const none = await resolveComponents({ resolve: () => null }, 'b1', { refs: [], page: 'p', renders: [{ ref: 'w', key: 'k', props: {} }] })
  expect(none.html).toEqual([{ ref: 'w', key: 'k', html: null }])
  const components: RuntimeComponents = {
    resolve: () => null,
    render(ref) {
      if (ref === 'a') return null
      if (ref === 'b') throw new Error('boom')
      if (ref === 'c') return 42 as unknown as string
      return '<i>d</i>'
    },
  }
  const r = await resolveComponents(components, 'b1', {
    refs: [],
    renders: ['a', 'b', 'c', 'd'].map((ref) => ({ ref, key: ref, props: {} })),
  })
  expect(r.html).toEqual([
    { ref: 'a', key: 'a', html: null },
    { ref: 'b', key: 'b', error: 'Error: boom' },
    { ref: 'c', key: 'c', error: 'components.render returned number, not a string or null' },
    { ref: 'd', key: 'd', html: '<i>d</i>' },
  ])
})

test('a request without renders answers the F519 shape', async () => {
  const r = await resolveComponents({ resolve: () => staticArt }, 'b1', { refs: ['x'] })
  expect(r).toEqual({ results: [{ ref: 'x', artifact: staticArt }] })
})

// F572: `ctx.notNow()` (sync or through a promise) answers `notNow: true` for that pair only.
test('ctx.notNow() answers notNow for that pair, sync and async', async () => {
  const components: RuntimeComponents = {
    resolve: () => null,
    render(ref, _props, ctx) {
      if (ref === 'sync') return ctx.notNow()
      if (ref === 'async') return Promise.resolve(ctx.notNow())
      return '<i>ok</i>'
    },
  }
  const r = await resolveComponents(components, 'b1', {
    refs: [],
    page: 'p',
    renders: [
      { ref: 'sync', key: 'k1', props: {} },
      { ref: 'async', key: 'k2', props: {} },
      { ref: 'ok', key: 'k3', props: {} },
    ],
  })
  expect(r.html).toEqual([
    { ref: 'sync', key: 'k1', notNow: true },
    { ref: 'async', key: 'k2', notNow: true },
    { ref: 'ok', key: 'k3', html: '<i>ok</i>' },
  ])
  // a look-alike object is not the not-now value: as before, a non-string is an error
  const fake: RuntimeComponents = { resolve: () => null, render: () => ({ __brustRenderNotNow: true }) as never }
  const f = await resolveComponents(fake, 'b1', { refs: [], page: 'p', renders: [{ ref: 'x', key: 'k', props: {} }] })
  expect(f.html).toEqual([{ ref: 'x', key: 'k', error: 'components.render returned object, not a string or null' }])
  // F588: `notNow` does not read `this`: a detached call answers not-now, and a copy of the value is the error above
  const detached: RuntimeComponents = {
    resolve: () => null,
    render(ref, _props, ctx) {
      if (ref === 'detached') {
        const { notNow } = ctx
        return notNow()
      }
      return { ...ctx.notNow() }
    },
  }
  const d = await resolveComponents(detached, 'b1', {
    refs: [],
    page: 'p',
    renders: [
      { ref: 'detached', key: 'k1', props: {} },
      { ref: 'copy', key: 'k2', props: {} },
    ],
  })
  expect(d.html).toEqual([
    { ref: 'detached', key: 'k1', notNow: true },
    { ref: 'copy', key: 'k2', error: 'components.render returned object, not a string or null' },
  ])
})
