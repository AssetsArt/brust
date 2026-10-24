import { Outer } from './ctx'
// F375 (b) negative: the call site spreads an object that may carry children: Prov keeps the F374 refusal.
export default function Page(p: { children?: React.ReactNode }) {
  return (
    <main>
      <Outer {...p} />
    </main>
  )
}
