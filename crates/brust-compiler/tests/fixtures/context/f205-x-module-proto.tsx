const ITEMS = [{ __proto__: { label: { toUpperCase: () => 'x' } } }]
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page() {
  return <Wrap>{ITEMS.map((i, k) => <p key={k}>{(i as any).label.toUpperCase()}</p>)}</Wrap>
}
