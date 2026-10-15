import { wrap } from 'some-wrap'
const xs = ['a']
// Package code handed a function that writes a module binding may call it at load time: not an accepted value.
export const W = wrap(() => {
  xs.push('b')
})
function get() {
  return xs.join(',')
}
export default function Page() {
  return <section>{get()}</section>
}
