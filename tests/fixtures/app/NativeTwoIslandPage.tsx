import Counter from '../../../example/hello-world/components/Counter'

// Two <Island component={Counter} …/> reusing the SAME Counter component:
//   - instance 0: client-only (no ssr) — empty data-brust-csr mount
//   - instance 1: ssr — server-rendered <button> inside the mount
// The two instances carry DISTINCT props paths (`first` vs `second`), so their
// data-brust-props differ. Both produce ONE shared Counter.js chunk (dedup by
// component name) — the component-addressed-islands acceptance §3 proof.
export default function NativeTwoIslandPage({
  greeting,
  first,
  second,
}: {
  greeting: string
  first: { start: number }
  second: { start: number }
}) {
  return (
    <div>
      <h1>{greeting}</h1>
      <Island component={Counter} props={first} />
      <Island component={Counter} props={second} ssr />
    </div>
  )
}
