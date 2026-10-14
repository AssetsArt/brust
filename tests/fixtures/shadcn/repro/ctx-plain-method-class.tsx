class Box {
  toString() {
    return <b>hi</b>
  }
}
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  const b = new Box()
  return <Wrap>{b.toString()}</Wrap>
}
