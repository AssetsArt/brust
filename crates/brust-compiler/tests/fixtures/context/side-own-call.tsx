const xs = ['a']
const fmt = (v: string) => v.toUpperCase()
const L = fmt('a')
const reg = { pick(v: string) { return v } }
const P2 = reg.pick('x')
export default function Page() {
  return <section>{xs.join(',')}{L}{P2}</section>
}
