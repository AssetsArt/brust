import { SwitchChain, type Section } from './parts'
function Rows({ sections }: { sections: Section[] }) {
  return <main>{sections.map((s) => <SwitchChain key={s.id} s={s} />)}</main>
}
export default function SwitchChainPage({ sections }: { sections: Section[] }) {
  return <Rows sections={sections} />
}
