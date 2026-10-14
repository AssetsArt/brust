import { createContextScope } from '@radix-ui/react-context'

const [createXContext, createXScope] = createContextScope('X')
const [XProvider, useXContext] = createXContext<{ value: number; max: number }>('X')
void createXScope

function Root({ value, max = 100, children, __scopeX }: any) {
  return (
    <XProvider scope={__scopeX} value={value} max={max}>
      <div role="progressbar">{children}</div>
    </XProvider>
  )
}

function Indicator({ __scopeX }: any) {
  const context = useXContext('Indicator', __scopeX)
  return <i data-value={context.value} data-max={context.max} />
}

export default function Page() {
  return (
    <Root value={66}>
      <Indicator />
    </Root>
  )
}
