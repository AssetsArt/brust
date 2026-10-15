const list = [<b>hi</b>]
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{list[0]}</Wrap>
}
