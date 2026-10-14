const ROWS = [{ o: { toString: () => 'x' } }]
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{ROWS.map((r, i) => <p key={i}>{r.o.toString()}</p>)}</Wrap>
}
