
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page() {
  return <Wrap>{['a', 'b'].map((s) => <p key={s}>{s.toUpperCase()}</p>)}</Wrap>
}
