import { el } from './lib/els'

export default function Page() {
  const on = true
  return <section>{on && el}</section>
}
