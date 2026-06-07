// NATIVE behavior component — a "Show code" toggle + collapsible code panel for the
// hero demo card. Self-contained (own x-data scope); imports ONLY brustjs/store so
// its directive chunk bundles for the browser (a behavior chunk must not import the
// full `brustjs` runtime / Island — those pull Node builtins). codeHtml is
// server-highlighted (loader) and injected raw.
import { computed, signal } from 'brustjs/store'

export const behavior = () => {
  const open = signal(false)
  const toggle = () => open.set(!open())
  const label = computed(() => (open() ? 'Hide code' : 'Show code'))
  return { open, toggle, label }
}

// The code shown in the panel. Lives here (a real behavior file) so the directive
// text-scan doesn't false-positive on the phrase it contains (gap G5).
export const source = `// stores/shared.ts — one store, shared everywhere
import { defineStore, signal } from 'brustjs/store'

export const demoStore = defineStore('home.demo', () => {
  const count = signal(0)
  return { count }
})

// native, react-free — bind x-* to the store signal
export const behavior = () => {
  const { count } = demoStore
  return { count, inc: () => count.set(count() + 1) }
}
//  <span x-text="count">0</span>

// React island — the SAME store via useStore
import { useStore } from 'brustjs/client'

export default function Counter() {
  const { count } = useStore(demoStore)
  return <span>{count}</span>
}`

export default function CodeReveal({ codeHtml }: { codeHtml: string }) {
  return (
    <div className="b-reveal">
      <button type="button" x-on-click="toggle" x-text="label" className="b-reveal__btn">
        Show code
      </button>
      <div x-show="open" className="b-reveal__panel b-code b-code--bare">
        <div className="b-code__scroll">
          <pre>
            {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted trusted code (Prism, build-time loader) — never user input */}
            <code dangerouslySetInnerHTML={{ __html: codeHtml }} />
          </pre>
        </div>
      </div>
    </div>
  )
}
