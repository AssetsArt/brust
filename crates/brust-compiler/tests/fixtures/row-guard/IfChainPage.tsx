import { IfChain, type Section } from './parts'
function Rows({ sections }: { sections: Section[] }) {
  return <main>{sections.map((s) => <IfChain key={s.id} s={s} />)}</main>
}
export default function IfChainPage({ sections }: { sections: Section[] }) {
  return <Rows sections={sections} />
}
