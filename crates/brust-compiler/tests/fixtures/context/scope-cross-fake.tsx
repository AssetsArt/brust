import { createYScope } from './scope-fake'

const useYScope = createYScope()

function Leaf({ n }: { n: number }) {
  return <b data-n={n} />
}
function Indicator(props: any) {
  const scope = useYScope(props.__scopeY)
  return <Leaf {...scope} n={1} />
}
export default function Page() {
  return <Indicator />
}
