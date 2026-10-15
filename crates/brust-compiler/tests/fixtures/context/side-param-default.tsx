const xs = ['a']
const add = (v: string) => {
  xs.push(v)
  return 1
}
function f(a = add('b')) {
  return a
}
const _r = f()
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
