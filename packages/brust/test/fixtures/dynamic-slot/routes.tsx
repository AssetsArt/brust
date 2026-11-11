import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineRoutes, type RuntimeArtifact, type RuntimeComponents } from '@brust/core'
import List from './List'
import Other from './Other'
import Root from './Root'

// Hand-written artifacts per the R2 contract (no compile API needed): a static one, a native one that reads and writes
// the exposed `cart` store and reads a prop passed through <Dynamic props>, a missing ref and a throwing resolver.
let calls = 0

function urls(): { runtime: string; sdk: string } {
  const m = JSON.parse(readFileSync(join(process.env.BRUST_DIST_DIR ?? 'dist', 'manifest.json'), 'utf8'))
  return { runtime: `/_brust/${m.assets.runtime}`, sdk: `/_brust/${m.runtime.exposed['shop/sdk.ts']}` }
}

function artifact(ref: string, build: string): RuntimeArtifact | null {
  if (ref === 'hello')
    return { v: 1, build, id: 'rc_hello_v1', tier: 'static', jinja: '<b class="rc-hello">{{ label | e }}</b>', client: null, features: [], stores: [] }
  if (ref === 'counter') {
    const u = urls()
    return {
      v: 1,
      build,
      id: 'rc_counter_v1',
      tier: 'native',
      jinja:
        '<button type="button" x-data="rc_counter_v1" x-props=\'{{ _props | json_attr }}\' data-testid="rc-counter" x-on-click="_h1">{{ label | e }} <span x-text="_c1">{{ __store.cart.count | e }}</span></button>',
      client: [
        `import { computed, defineBehavior } from ${JSON.stringify(u.runtime)}`,
        `import { cart } from ${JSON.stringify(u.sdk)}`,
        'export default defineBehavior("rc_counter_v1", ({ props }) => {',
        '  const _c1 = computed(() => cart.count())',
        '  const _h1 = () => { globalThis.__rcLabel = props().label; cart.count.set(cart.count() + 1) }',
        '  return { _c1, _h1 }',
        '})',
      ].join('\n'),
      features: ['basics', 'store'],
      stores: ['cart'],
    }
  }
  if (ref === 'boom') throw new Error('the component store is down')
  return null
}

export const components: RuntimeComponents = {
  resolve(ref, { build }) {
    calls++
    return artifact(ref, build)
  },
}

// A root layout makes every page a full document, so the client's SPA navigation script is on it (a page without <body> is loaded whole).
export const routes = defineRoutes([
  {
    Component: Root,
    children: [
  {
    path: '/',
    Component: List,
    loader: () => ({
      items: [
        { ref: 'hello', label: 'Hi' },
        { ref: 'counter', label: 'Add' },
        { ref: 'gone', label: 'x' },
        { ref: 'boom', label: 'y' },
      ],
    }),
  },
  { path: '/other', Component: Other, loader: () => ({ calls }) },
    ],
  },
])
