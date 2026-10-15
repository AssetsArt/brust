const xs = ['a']
class R { static { xs.push('b') } }
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
