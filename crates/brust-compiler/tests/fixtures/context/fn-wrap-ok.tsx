import { createContextScope } from '@radix-ui/react-context'

const [createPContext, createPScope] = createContextScope('P')
const [PProvider, usePContext] = createPContext<{ value: number | null; max: number }>('P')
void createPScope

function Root(props: any) {
  const { __scopeP, value: valueProp = null, max: maxProp, getValueLabel = defaultLabel, ...rest } = props
  const max = isValid(maxProp) ? maxProp : 100
  const value = isNum(valueProp) ? valueProp : null
  const label = isNum(value) ? getValueLabel(value, max) : undefined
  return (
    <PProvider scope={__scopeP} value={value} max={max}>
      <div role="progressbar" aria-valuetext={label} data-max={max} {...rest} />
    </PProvider>
  )
}
function Ind(props: any) {
  const { __scopeP, ...rest } = props
  const c = usePContext('Ind', __scopeP)
  return <i data-value={c.value ?? undefined} data-max={c.max} {...rest} />
}
function defaultLabel(value: number, max: number) {
  return `${Math.round((value / max) * 100)}%`
}
function isNum(v: any): v is number {
  return typeof v === 'number'
}
function isValid(m: any): m is number {
  return isNum(m) && !isNaN(m) && m > 0
}
function Wrap({ className, ...props }: any) {
  return (
    <Root {...props}>
      <Ind />
    </Root>
  )
}
export default function Page() {
  return (
    <main>
      <Wrap className="c" data-x="1" />
    </main>
  )
}
