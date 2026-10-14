function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ m = 'toUpperCase' }: { m?: 'toUpperCase' }) {
  const s = 'hi'
  return <Wrap>{s[m]()}</Wrap>
}
