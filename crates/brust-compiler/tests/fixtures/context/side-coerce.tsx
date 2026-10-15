const xs = ['a']
const o = {
  toString() {
    xs.push('b')
    return 'o'
  },
}
const s = `${o}`
function get() {
  return xs.join(',')
}
export default function Page() {
  return <section>{get()}</section>
}
