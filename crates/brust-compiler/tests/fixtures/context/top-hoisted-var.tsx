import { icons } from './lib/els'
{
  var home = icons.home
}
function pick() {
  return home
}

export default function Page() {
  return <section>{pick()}</section>
}
