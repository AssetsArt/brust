import { createContextScope } from '@radix-ui/react-context'
import { createYScope } from './scope-mod'

const [createZContext, createZScope] = createContextScope('Z')
void createZScope
const [ZProvider, useZContext] = createZContext<{ value: number }>('Z')
const useYScope = createYScope()

function Leaf({ n }: { n: number }) {
  return <b data-n={n} />
}
function Indicator(props: any) {
  const context = useZContext('Indicator', props.__scopeZ)
  const scope = useYScope(props.__scopeY)
  return <Leaf {...scope} n={context.value} />
}
export default function Page() {
  return (
    <ZProvider value={5}>
      <Indicator />
    </ZProvider>
  )
}
