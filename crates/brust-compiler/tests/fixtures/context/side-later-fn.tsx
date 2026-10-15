import { later } from 'some-later'
const cfg = { v: 'a' }
function pick() {
  return cfg
}
const _r = later(pick)
function get() {
  return cfg.v
}
export default function Page() {
  return <section>{get()}</section>
}
