import { type Section, SectionView } from './SectionView'

export function PageView({ sections }: { sections: Section[] }) {
  return (
    <main>
      {sections.map((s) => (
        <SectionView key={s.id} s={s} />
      ))}
    </main>
  )
}
