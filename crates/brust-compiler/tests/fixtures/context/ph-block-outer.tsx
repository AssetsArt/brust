// F194 (Mellow's siblings): an outer local shadowed inside a block: after the block `n` is the outer primitive again, and stays plain.
function label(c: boolean) {
  const n = c ? 1 : 2
  {
    const n = 'inner'
    if (c) return n
  }
  return n
}
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ on }: { on: boolean }) {
  return <Wrap>{label(on)}</Wrap>
}
