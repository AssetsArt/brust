const xs = ['a']
const o = {
  xs,
  add() {
    this.xs.push('b')
    return 1
  },
}
const _r = o.add()
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
