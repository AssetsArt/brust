const el = <b>hi</b>

function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  const on = true
  return <Wrap>{on && el}</Wrap>
}
