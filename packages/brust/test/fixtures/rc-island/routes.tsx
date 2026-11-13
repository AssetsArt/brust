import { defineRoutes, type IslandArtifact, type RuntimeComponents } from '@brust/core'
import List from './List'
import Other from './Other'
import Root from './Root'

// F546: a component the app renders itself. Its HTML comes from `render` (per props), its client module registers the
// hydrate function the island runtime calls. The id changes with the client (here: by hand, v1).
const CLIENT = `const w = globalThis
w.__rcIsl ||= { hydrated: [], disposed: 0 }
;(w.__brustIslands ||= []).push(['isl_counter_v1', (host, props, committed) => {
  w.__rcIsl.hydrated.push(props)
  const b = host.querySelector('button')
  let n = 0
  const on = () => { n++; b.textContent = props.label + ' ' + n }
  b.addEventListener('click', on)
  committed()
  return () => { b.removeEventListener('click', on); w.__rcIsl.disposed++ }
}])
w.__brustIslandReady?.()
`

let renders = 0
const pages: Record<string, number> = {}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const components: RuntimeComponents = {
  resolve(ref, { build }) {
    if (ref !== 'counter') return null
    const a: IslandArtifact = { v: 1, build, id: 'isl_counter_v1', tier: 'island', client: CLIENT }
    return a
  },
  render(ref, props, { page }) {
    renders++
    pages[page.id] = page.total
    return `<button type="button" data-testid="rc-isl">${esc(String(props.label))} 0</button>`
  },
}

export const routes = defineRoutes([
  {
    Component: Root,
    children: [
      {
        path: '/',
        Component: List,
        loader: () => ({
          items: [
            { key: 'r1', ref: 'counter', label: "it's <a>" },
            { key: 'r2', ref: 'counter', label: 'two' },
            { key: 'r3', ref: 'counter', label: 'three' },
          ],
        }),
      },
      { path: '/other', Component: Other, loader: () => ({ renders, pages: JSON.stringify(pages) }) },
    ],
  },
])
