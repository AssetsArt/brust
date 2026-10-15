const xs = ['a']
function grow() {
  xs.push('b')
  return xs.length
}
export const size = grow()
function get() {
  return xs.join(',')
}

export default function Page() {
  return <section>{get()}</section>
}
