import { pick } from './lib/helpers'
function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{pick({ name: 'n' })}</Wrap>
}
