const ITEMS = [{ label: 'alpha', n: 1 }, { label: 'beta', n: 2 }]
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page() {
  return <Wrap>{ITEMS.map((i) => <p key={i.label}>{i.label.toUpperCase()} {i.n.toFixed(1)}</p>)}</Wrap>
}
