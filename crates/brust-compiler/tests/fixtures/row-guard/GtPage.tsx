import { Gt, type Section } from './parts'
function Rows({ sections }: { sections: Section[] }) {
  return <main>{sections.map((s) => <Gt key={s.id} s={s} />)}</main>
}
export default function GtPage({ sections }: { sections: Section[] }) {
  return <Rows sections={sections} />
}
