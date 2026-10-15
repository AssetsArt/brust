const xs = ['a']
const _r = ['b'].forEach((v) => { xs.push(v) })
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
