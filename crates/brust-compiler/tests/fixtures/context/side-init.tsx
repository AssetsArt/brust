const xs = ['a']
const n = xs.push('b')
function get() {
  return xs.join(',')
}

export default function Page() {
  return <section>{get()}</section>
}
