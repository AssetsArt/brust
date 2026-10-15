const xs = ['a']
const reg = { put(v: string) { xs.push(v) } }
const _r = reg.put('b')
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
