import { SectionView } from './SectionView'
type Section = { id: string; type: string; data: { title: string; price: string } }
export function PageView({ sections }: { sections: Section[] }) {
  return <main>{sections.map((s) => <SectionView key={s.id} s={s} />)}</main>
}
