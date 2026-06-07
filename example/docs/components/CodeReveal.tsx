// NATIVE behavior component — "Show code" toggle + a TABBED code viewer for the hero
// demo (one tab per real file: the store, the native component, the React island).
// Self-contained x-data scope; imports ONLY brustjs/store so its directive chunk
// bundles for the browser (a behavior chunk must not import the full brustjs
// runtime / Island). The three code HTMLs are server-highlighted in the loader.
import { computed, signal } from 'brustjs/store'

export const behavior = () => {
  const open = signal(false)
  const tab = signal('store')
  const toggle = () => open.set(!open())
  const label = computed(() => (open() ? 'Hide code' : 'Show code'))
  const setStore = () => tab.set('store')
  const setNative = () => tab.set('native')
  const setIsland = () => tab.set('island')
  const isStore = computed(() => tab() === 'store')
  const isNative = computed(() => tab() === 'native')
  const isIsland = computed(() => tab() === 'island')
  const storeCls = computed(() => (tab() === 'store' ? 'b-tab b-tab--on' : 'b-tab'))
  const nativeCls = computed(() => (tab() === 'native' ? 'b-tab b-tab--on' : 'b-tab'))
  const islandCls = computed(() => (tab() === 'island' ? 'b-tab b-tab--on' : 'b-tab'))
  return {
    open,
    toggle,
    label,
    setStore,
    setNative,
    setIsland,
    isStore,
    isNative,
    isIsland,
    storeCls,
    nativeCls,
    islandCls,
  }
}

// The three real files, shown one per tab. They live here (a behavior file) so the
// directive text-scan doesn't false-positive on the phrase the native one contains
// (gap G5). Kept in lockstep with stores/shared.ts, SharedNative.tsx, and
// SharedCounter.island.tsx.
export const storeSrc = `import { defineStore, signal } from 'brustjs/store'

// One instance on window.__BRUST_STORES__['home.demo'] — the native
// component and the React island both resolve to the SAME signal.
export const demoStore = defineStore('home.demo', () => {
  const count = signal(0)
  return { count }
})`

export const nativeSrc = `import { demoStore } from '../stores/shared'

// react-free: the behavior binds x-* to the shared store signal
export const behavior = () => {
  const { count } = demoStore
  return {
    count,
    inc: () => count.set(count() + 1),
    dec: () => count.set(count() - 1),
  }
}

export default function SharedNative() {
  return (
    <div className="row">
      <button x-on-click="dec">−</button>
      <span x-text="count">0</span>
      <button x-on-click="inc">+</button>
    </div>
  )
}`

export const islandSrc = `import { useStore } from 'brustjs/client'
import { demoStore } from '../stores/shared'

// React island — subscribe to the SAME store, write through it
export default function SharedCounter() {
  const { count } = useStore(demoStore)
  return (
    <div className="row">
      <button onClick={() => demoStore.count.set(demoStore.count() - 1)}>−</button>
      <span>{count}</span>
      <button onClick={() => demoStore.count.set(demoStore.count() + 1)}>+</button>
    </div>
  )
}`

export default function CodeReveal({
  storeHtml,
  nativeHtml,
  islandHtml,
}: {
  storeHtml: string
  nativeHtml: string
  islandHtml: string
}) {
  return (
    <div className="b-reveal">
      <button type="button" x-on-click="toggle" x-text="label" className="b-reveal__btn">
        Show code
      </button>
      <div x-show="open" className="b-reveal__body">
        <div className="b-tabs">
          <button type="button" x-on-click="setStore" x-bind-class="storeCls" className="b-tab b-tab--on">
            shared.ts
          </button>
          <button type="button" x-on-click="setNative" x-bind-class="nativeCls" className="b-tab">
            SharedNative.tsx
          </button>
          <button type="button" x-on-click="setIsland" x-bind-class="islandCls" className="b-tab">
            SharedCounter.island.tsx
          </button>
        </div>
        <div x-show="isStore" className="b-code b-code--bare">
          <div className="b-code__scroll">
            <pre>
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted trusted code (Prism, build-time loader) — never user input */}
              <code dangerouslySetInnerHTML={{ __html: storeHtml }} />
            </pre>
          </div>
        </div>
        <div x-show="isNative" className="b-code b-code--bare">
          <div className="b-code__scroll">
            <pre>
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted trusted code (Prism, build-time loader) — never user input */}
              <code dangerouslySetInnerHTML={{ __html: nativeHtml }} />
            </pre>
          </div>
        </div>
        <div x-show="isIsland" className="b-code b-code--bare">
          <div className="b-code__scroll">
            <pre>
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted trusted code (Prism, build-time loader) — never user input */}
              <code dangerouslySetInnerHTML={{ __html: islandHtml }} />
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}
