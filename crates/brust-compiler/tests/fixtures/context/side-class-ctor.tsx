const xs = ['a']
class R { constructor() { xs.push('b') } }
const r = new R()
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
