import { later } from './lib/missing'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{later(1)}</Wrap>
}
