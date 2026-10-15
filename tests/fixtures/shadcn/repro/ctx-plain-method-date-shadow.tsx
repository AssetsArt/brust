class Date {
  constructor(_v: string) {}
  toISOString() {
    return <b>hi</b>
  }
}
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{new Date('x').toISOString()}</Wrap>
}
