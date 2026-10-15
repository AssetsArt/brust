const xs = ['a']
// Callables that write nothing, declared and not called at load time: accepted (functions and an object of functions).
const fmt = (v: string) => v.toUpperCase()
const reg = { pick(v: string) { return v } }
export { fmt, reg }
export default function Page() {
  return <section>{xs.join(',')}</section>
}
