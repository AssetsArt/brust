import { useState } from 'react'
import { createContextScope } from '@radix-ui/react-context'

const [createXContext] = createContextScope('X')
const [XProvider, useXContext] = createXContext<{ value: number }>('X')
// named like a scope hook, but not made by createContextScope
const makeScope = () => () => ({})
const useXScope = makeScope()

function Leaf({ n }: { n: number }) {
  return <b data-n={n} />
}
function Indicator(props: any) {
  const [k] = useState(0)
  const context = useXContext('Indicator', props.__scopeX)
  const scope = useXScope(props.__scopeX)
  return <Leaf {...scope} n={context.value + k} />
}
export default function Page() {
  return (
    <XProvider value={1}>
      <Indicator />
    </XProvider>
  )
}
