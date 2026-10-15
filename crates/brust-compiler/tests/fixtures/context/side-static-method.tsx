const xs = ['a']
class R {
  static add() {
    xs.push('b')
    return 1
  }
}
const _r = R.add()
function get() {
  return xs.join(",")
}
export default function Page() {
  return <section>{get()}</section>
}
