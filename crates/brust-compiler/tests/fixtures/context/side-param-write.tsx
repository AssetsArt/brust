const cfg = { v: 'a' }
const _r = [cfg].forEach((o) => {
  o.v = 'b'
})
function get() {
  return cfg.v
}
export default function Page() {
  return <section>{get()}</section>
}
