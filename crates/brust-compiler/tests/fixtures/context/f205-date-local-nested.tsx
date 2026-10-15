function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ at }: { at: string }) {
  const d = new Date(at)
  const label = d.toLocaleDateString()
  return <Wrap>{label.toUpperCase()}</Wrap>
}
