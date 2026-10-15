const ITEMS = [{ label: 'a' }]
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page() {
  return <Wrap>{ITEMS[1].label.toUpperCase()}</Wrap>
}
