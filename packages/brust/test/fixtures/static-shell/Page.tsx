import SectionView from './SectionView'
import type { Section } from './types'

export default function Page({ sections }: { sections: Section[] }) {
  return (
    <main>
      {sections.map((s) => (
        <SectionView key={s.id} s={s} />
      ))}
    </main>
  )
}
