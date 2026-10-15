const xs = ['a']
const fns = [() => xs.push('b')]
const _r = fns.map((f) => f())
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
