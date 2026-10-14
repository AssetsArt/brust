import { icons } from './lib/els'
import { tag } from './lib/helpers'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{tag(icons.home)}</Wrap>
}
