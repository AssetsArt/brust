import { later } from 'some-later'
const cfg = { v: 'a' }
const _r = later(() => cfg)
function get() {
  return cfg.v
}
export default function Page() {
  return <section>{get()}</section>
}
