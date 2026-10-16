// F194 (Mellow's siblings): a catch parameter (the proof refuses try outright).
function label(c: boolean) {
  try {
    if (c) throw 1
  } catch (document) {}
  return document
}
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ on }: { on: boolean }) {
  return <Wrap>{label(on)}</Wrap>
}
