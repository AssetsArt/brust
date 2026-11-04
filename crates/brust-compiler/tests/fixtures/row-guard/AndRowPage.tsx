import { AndRow, type Section } from './parts'
function Rows({ sections }: { sections: Section[] }) {
  return <main>{sections.map((s) => <AndRow key={s.id} s={s} />)}</main>
}
export default function AndRowPage({ sections }: { sections: Section[] }) {
  return <Rows sections={sections} />
}
