import { Price, type Section } from './parts'
// F142 at the root: a per-row record of the page itself, under a branch.
export default function RootPage({ sections }: { sections: Section[] }) {
  return <main>{sections.map((s) => (s.type === 'price' ? <Price key={s.id} price={s.data.price!} /> : <p key={s.id}>{s.data.title}</p>))}</main>
}
