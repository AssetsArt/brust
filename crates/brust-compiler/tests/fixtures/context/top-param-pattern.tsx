import { icons } from './lib/els'
function pick({ x = icons.home }: { x?: unknown } = {}) {
  return x
}

export default function Page() {
  return <section><i>{pick()}</i></section>
}
