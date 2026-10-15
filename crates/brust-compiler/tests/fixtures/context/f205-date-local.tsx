
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ at }: { at: string }) {
  const d = new Date(at)
  return <Wrap>{d.toLocaleDateString()}</Wrap>
}
