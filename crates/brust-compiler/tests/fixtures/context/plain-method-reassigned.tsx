const d = new Date(0)
d.toISOString = () => (<b>hi</b>) as unknown as string
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{d.toISOString()}</Wrap>
}
