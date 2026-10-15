import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal, computed } from '../src/signal'

// Step 0 of the 2c design note (Amendment 2026-10-15b, R34.116-R34.119): a collapsible written by hand in the shape the
// native Provider will print, so the runtime semantics the compiler relies on are pinned before any compiler code.
// Provider = the host. Its static consumers are inlined into its region (directives owned by the Provider's instance);
// a consumer with its own state/ref/effect is a nested host fed through `x-props-bind` to a `computed` member `_pN`.
beforeEach(() => { unmount(); document.body.innerHTML = '' })
const flush = () => new Promise((r) => setTimeout(r, 0))

function define(name: string, log: string[] = []) {
  defineBehavior(name, () => {
    const open = signal(false)
    const toggle = () => open.set(!open())
    return {
      open, toggle,
      state: computed(() => (open() ? 'open' : 'closed')),
      // R34.119: the frame a native consumer reads, evaluated in the browser from client-closed members only.
      _p1: computed(() => ({ open: open(), onToggle: toggle })),
    }
  })
  defineBehavior(`${name}_impl`, ({ props, effect, ref }) => {
    const box = ref('box')
    effect(() => { log.push(`impl:${props().open ? 'open' : 'closed'}:${box.current ? 'ref' : 'noref'}`) })
    return { _c1: computed(() => (props().open ? 'open' : 'closed')) }
  })
}

const page = (n: string) => `
  <div id="root" x-data="${n}" data-state="closed" x-bind-data-state="state">
    <button id="trig" aria-expanded="false" x-bind-aria-expanded="open" x-on-click="toggle">t</button>
    <p id="content" x-if="open" hidden>shown</p>
    <i id="impl" x-data="${n}_impl" x-props='{"open":false}' x-props-bind="_p1" x-ref="box" x-bind-data-state="_c1" data-state="closed"></i>
  </div>`

// A directive printed ON a host element is bound by that host's own instance (here `x-if="open"` next to `x-data` looked
// for `open` in the consumer): a conditional native consumer needs its condition on a non-host element.
test('static Trigger (owned by the Provider) toggles; a static region and a native consumer follow the frame', async () => {
  const log: string[] = []; define('coll_a', log)
  document.body.innerHTML = page('coll_a')
  mount(); await flush()
  const trig = document.getElementById('trig')!
  expect(document.getElementById('content')).toBeNull()
  expect(trig.getAttribute('aria-expanded')).toBe('false')
  trig.click(); await flush()
  expect(trig.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById('root')!.getAttribute('data-state')).toBe('open')
  expect(document.getElementById('content')).not.toBeNull()
  expect(document.getElementById('impl')!.getAttribute('data-state')).toBe('open')
  expect(log.at(-1)).toBe('impl:open:ref')
  trig.click(); await flush()
  expect(document.getElementById('content')).toBeNull()
  expect(document.getElementById('impl')!.getAttribute('data-state')).toBe('closed')
})

test('A1: a directive of the OUTER instance printed under a nested instance binds to the nested one (why the guard needs host identity)', async () => {
  define('coll_o'); define('coll_i')
  document.body.innerHTML = `<div x-data="coll_o"><button id="outer" x-on-click="toggle">o</button><div x-data="coll_i"><button id="b" x-on-click="toggle">i</button><span id="leak" x-text="state">closed</span></div></div>`
  mount(); await flush()
  // `state` is authored as the OUTER's member but sits under the inner host: the runtime resolves the nearest x-data.
  document.getElementById('outer')!.click()
  expect(document.getElementById('leak')!.textContent).toBe('closed')
  document.getElementById('b')!.click()
  expect(document.getElementById('leak')!.textContent).toBe('open')
})

test('A1: sibling instances of one Provider keep their own state', async () => {
  define('coll_s')
  const one = (k: string) => page('coll_s').replace('id="root"', `id="r${k}"`).replace('id="trig"', `id="t${k}"`).replace('id="content"', `id="c${k}"`).replace('id="impl"', `id="m${k}"`)
  document.body.innerHTML = one('1') + one('2')
  mount(); await flush()
  document.getElementById('t1')!.click(); await flush()
  expect(document.getElementById('c1')).not.toBeNull()
  expect(document.getElementById('c2')).toBeNull()
  expect(document.getElementById('m2')!.getAttribute('data-state')).toBe('closed')
})
