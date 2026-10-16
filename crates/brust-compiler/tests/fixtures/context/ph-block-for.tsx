// F194 (Mellow's siblings): a for-loop body (the proof refuses loops outright).
function label(c: boolean) {
  for (let i = 0; i < 1; i++) {
    const window = 0
  }
  return window
}
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}
export default function Page({ on }: { on: boolean }) {
  return <Wrap>{label(on)}</Wrap>
}
