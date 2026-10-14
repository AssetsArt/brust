function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page({ s = 'hi' }: { s?: string }) {
  return <Wrap>{s.toUpperCase?.()}</Wrap>
}
