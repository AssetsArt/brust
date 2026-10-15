import { icons } from './ctxlib/els'
const A = (0, icons.home)
function pick() {
  return A
}

export default function Page() {
  return <section>{pick()}</section>
}
