const xs = ['a']
const o = { get v() { xs.push('b'); return 1 } }
const n = o.v
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
