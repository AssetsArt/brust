import { thing } from 'some-unresolvable-package'

function Wrap({ children }: { children?: React.ReactNode }) {
  return <section>{children}</section>
}

export default function Page() {
  return <Wrap>{thing}</Wrap>
}
