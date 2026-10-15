const xs = ['a']
const add = (v: string) => { xs.push(v) }
const _r = ['b'].forEach(add)
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
