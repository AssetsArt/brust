const GROUPS = [{ name: 'g', items: [{ label: 'a' }, { label: 'b' }] }]
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page() {
  return <Wrap>{GROUPS.map((g) => <div key={g.name}>{g.items.map((i) => <p key={i.label}>{i.label.toUpperCase()}</p>)}</div>)}</Wrap>
}
