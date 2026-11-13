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
  expect(calls.map((c) => c[2])).toEqual([
    { build: 'b1', page: { id: 'pg1', total: 2 } },
    { build: 'b1', page: { id: 'pg1', total: 2 } },
  ])
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
