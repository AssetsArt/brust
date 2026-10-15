const ITEMS = [{ label: { toUpperCase: () => 'x' } }]
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page() {
  return <Wrap>{ITEMS.map((i, k) => <p key={k}>{i.label.toUpperCase()}</p>)}</Wrap>
}
