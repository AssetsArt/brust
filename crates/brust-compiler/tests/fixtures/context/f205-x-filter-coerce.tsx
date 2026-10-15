const ITEMS = [{ label: 'a', n: { valueOf() { (ITEMS[0] as any).label = { toUpperCase: () => 'x' }; return 1 } } }]
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page() {
  return <Wrap>{ITEMS.filter((i) => (i.n as any) > 0).map((i, k) => <p key={k}>{i.label.toUpperCase()}</p>)}</Wrap>
}
