import { defineRoutes, type RuntimeArtifact, type RuntimeComponents } from '@brust/core'
import { compileComponent } from '@brust/core/compile'
import List from './List'
import Other from './Other'

// The component sources an app would keep in a database: TEXT, created after `brust build`. The resolver compiles one with
// `compileComponent` the first time a page names its ref, and returns exactly what it produced.
const SOURCES: Record<string, string> = {
  promo: `import { useStore } from '@brust/core/store/react'
import { cart } from '../shop/sdk'

export default function Promo({ label }: { label: string }) {
  const c = useStore(cart)
  return (
    <button type="button" data-testid="rc-promo" onClick={() => cart.count.set(c.count + 1)}>
      {label} {c.count}
    </button>
  )
}
`,
  note: `export default function Note({ label }: { label: string }) {
  return <b className="rc-note">{label}</b>
}
`,
  // A source the compile API refuses (a private copy of an app module would split its state).
  bad: `import { cart } from '../not-exposed/sdk'
export default function Bad() {
  return <i>{String(cart)}</i>
}
`,
}

let compiles = 0
const refusals: Record<string, string[]> = {}

export const components: RuntimeComponents = {
  async resolve(ref, { build }) {
    const source = SOURCES[ref]
    if (source === undefined) return null
    compiles++
    const r = await compileComponent({ source, filename: `el/${ref[0]!.toUpperCase()}${ref.slice(1)}.tsx` })
    if (!r.ok) {
      refusals[ref] = r.diagnostics.filter((d) => d.class === 'error').map((d) => d.rule)
      return null
    }
    const a: RuntimeArtifact = r.artifact
    if (a.build !== build) throw new Error('artifact compiled for another build')
    return a
  },
}

export const routes = defineRoutes([
  {
    path: '/',
    Component: List,
    loader: () => ({
      items: [
        { ref: 'note', label: 'Hello' },
        { ref: 'promo', label: 'Add' },
        { ref: 'bad', label: 'x' },
        { ref: 'gone', label: 'y' },
      ],
    }),
  },
  { path: '/other', Component: Other, loader: () => ({ calls: compiles, refusals: JSON.stringify(refusals) }) },
])
