const xs = ['a']
const _i = (() => {
  xs.push('b')
  return 0
})()
function get() {
  return xs.join(",")
}

export default function Page() {
  return <section>{get()}</section>
}
