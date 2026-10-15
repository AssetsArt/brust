const ITEMS = [{ label: 'alpha', on: true }, { label: 'beta', on: false }]
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page() {
  return <Wrap>{ITEMS.filter((i) => i.on === true).map((i) => <p key={i.label}>{i.label.toUpperCase()}</p>)}</Wrap>
}
