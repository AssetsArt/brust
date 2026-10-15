const cfg = { v: 'a' }
// A module's own `forwardRef` is not React's: handing it a function that reads a module object is refused.
function forwardRef(f: () => { v: string }) {
  f().v = 'b'
  return 0
}
const _r = forwardRef(() => cfg)
function get() {
  return cfg.v
}
export default function Page() {
  return <section>{get()}</section>
}
