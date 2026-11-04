import { Ternary, type Section } from './parts'
function Rows({ sections }: { sections: Section[] }) {
  return <main>{sections.map((s) => <Ternary key={s.id} s={s} />)}</main>
}
export default function TernaryPage({ sections }: { sections: Section[] }) {
  return <Rows sections={sections} />
}
