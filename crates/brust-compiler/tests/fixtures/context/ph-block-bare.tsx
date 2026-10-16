// F194 (Mellow's siblings): a bare block: `globalThis` after it is the global object.
function label(c: boolean) {
  {
    const globalThis = c ? 1 : 2
  }
  return globalThis
}
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ on }: { on: boolean }) {
  return <Wrap>{label(on)}</Wrap>
}
