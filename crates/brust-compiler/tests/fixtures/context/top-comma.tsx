import { icons } from './lib/els'
const A = (0, icons.home)
function pick() {
  return A
}

export default function Page() {
  return <section>{pick()}</section>
}
