import { icons } from './lib/els'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{icons.home}</Wrap>
}
