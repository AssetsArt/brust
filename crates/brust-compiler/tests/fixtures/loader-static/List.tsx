import { Hero } from './Hero'
type Section = { id: string; type: string; data: { title: string; price: string } }
export function List({ sections }: { sections: Section[] }) {
  return <div>{sections.map((s) => <div key={s.id}><Hero title={s.data.title} /></div>)}</div>
}
