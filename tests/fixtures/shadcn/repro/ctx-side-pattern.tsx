const xs = ['a']
const add = (v: string) => {
  xs.push(v)
  return 1
}
const { a = add('b') } = {} as { a?: number }
function get() {
  return xs.join(',')
}

export default function Page() {
  return <section>{get()}</section>
}
