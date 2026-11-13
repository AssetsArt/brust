import { defineRoutes, type RuntimeComponents } from '@brust/core'
import { compileComponent } from '@brust/core/compile'
import List from './List'
import Menu from './Menu'
import Root from './Root'

// Runtime component sources (created after the build): `promo` places the listed island, `bad` an unlisted one.
const SOURCES: Record<string, string> = {
  promo: `import { Motion } from '../shop/sdk'
export default function Promo({ label }: { label: string }) {
  return (
    <section className="promo">
      <h3>{label}</h3>
      <Motion label={label} />
    </section>
  )
}
`,
  bad: `import { Unlisted } from '../shop/sdk'
export default function Bad({ label }: { label: string }) {
  return <Unlisted label={label} />
}
`,
}

export const refusals: Record<string, string[]> = {}

export const components: RuntimeComponents = {
  async resolve(ref) {
    const source = SOURCES[ref]
    if (source === undefined) return null
    const r = await compileComponent({ source, filename: `el/${ref}.tsx` })
    if (!r.ok) {
      refusals[ref] = r.diagnostics.filter((d) => d.class === 'error').map((d) => d.rule)
      return null
    }
    return r.artifact
  },
}

export const routes = defineRoutes([
  {
    Component: Root,
    children: [
      {
        path: '/',
        Component: List,
        loader: () => ({ items: [{ key: 'r1', label: 'one' }, { key: 'r2', label: 'two' }, { key: 'r3', label: 'three' }] }),
      },
      {
        path: '/menu',
        Component: Menu,
        loader: () => ({
          nodes: [
            { id: 'a', label: 'A' },
            { id: 'g', label: 'G', kids: [{ id: 'g1', label: 'G1' }, { id: 'g2', label: 'G2', kids: [{ id: 'g2x', label: 'G2X' }] }] },
          ],
        }),
      },
    ],
  },
])
