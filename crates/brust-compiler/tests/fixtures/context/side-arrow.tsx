const xs = ['a']
const add = (v: string) => { xs.push(v) }
const _r = add('b')
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
