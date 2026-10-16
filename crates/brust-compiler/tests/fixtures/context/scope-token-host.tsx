import { createContextScope } from '@radix-ui/react-context'

const [createXContext, createXScope] = createContextScope('X')
const [XProvider, useXContext] = createXContext<{ value: number }>('X')
const useXScope = createXScope()

function Leaf({ n }: { n: number }) {
  return <b data-n={n} />
}
function Root(props: any) {
  return (
    <XProvider scope={props.__scopeX} value={props.value}>
      <div>{props.children}</div>
    </XProvider>
  )
}

function Indicator(props: any) {
  const context = useXContext('Indicator', props.__scopeX)
  const scope = useXScope(props.__scopeX)
  return <i {...scope} data-v={context.value} />
}
export default function Page() {
  return (
    <Root value={1}>
      <Indicator />
    </Root>
  )
}
