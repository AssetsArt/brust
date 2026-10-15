const xs = ['a']
// A writer that nothing calls at module time: declaring it runs nothing.
export const add = (v: string) => {
  xs.push(v)
}
export const reg = { put(v: string) { xs.push(v) } }
export default function Page() {
  return <section>{xs.join(',')}</section>
}
