const marks = Array.from({ length: 2 }).map(() => <b>hi</b>)
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{marks.map((m, i) => <p key={i}>{m}</p>)}</Wrap>
}
