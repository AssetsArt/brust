import { CustomSectionView } from './CustomSectionView'
import { type El, ElementView } from './ElementView'

export type Section = { id: string; type: 'hero' | 'custom' | 'inline'; title?: string; nodes?: El[] }

// Picks a view per section type: through CustomSectionView, or the recursive list inline in the arm.
export function SectionView({ s }: { s: Section }) {
  switch (s.type) {
    case 'hero':
      return (
        <header data-id={s.id}>
          <h1>{s.title}</h1>
        </header>
      )
    case 'custom':
      return (
        <section data-id={s.id}>
          <CustomSectionView nodes={s.nodes ?? []} />
        </section>
      )
    case 'inline':
      return (
        <section data-id={s.id}>
          {(s.nodes ?? []).map((n) => (
            <ElementView key={n.id} n={n} />
          ))}
        </section>
      )
    default:
      return null
  }
}
