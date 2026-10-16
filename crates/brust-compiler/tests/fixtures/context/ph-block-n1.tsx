// F194, Mellow's N1 repro (context-lowering PR 1c): `document` after the block is the global object, not the block's
// `const`; `label` is not proven plain and the page falls back under the plain wrapper.
function label(c: boolean) {
  if (c) {
    const document = 1
  }
  return document
}
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ on }: { on: boolean }) {
  return <Wrap>{label(on)}</Wrap>
}
