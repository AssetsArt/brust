import { swapped } from './lib/helpers-let'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{swapped(1)}</Wrap>
}
