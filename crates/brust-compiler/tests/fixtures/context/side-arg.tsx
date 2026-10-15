import { register } from 'some-registry'

const xs = ['a']
export const handle = register(xs)
function get() {
  return xs.join(',')
}

export default function Page() {
  return <section>{get()}</section>
}
