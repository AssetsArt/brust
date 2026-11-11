import Custom from './Custom'
import type { Section } from './types'

export default function SectionView({ s }: { s: Section }) {
  switch (s.type) {
    case 'custom':
      return <Custom id={s.id} cls={s.cls} nodes={s.nodes ?? []} />
    case 'rule':
      return <hr data-id={s.id} />
    default:
      return <h2 data-id={s.id}>{s.title}</h2>
  }
}
