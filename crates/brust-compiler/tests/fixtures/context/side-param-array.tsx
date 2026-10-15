const rows = [{ v: 'a' }]
const _r = rows.forEach((o) => {
  o.v = 'b'
})
function get() {
  return rows[0].v
}
export default function Page() {
  return <section>{get()}</section>
}
