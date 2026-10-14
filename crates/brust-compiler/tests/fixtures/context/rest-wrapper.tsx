import { createContext, useContext } from 'react'

const Ctx = createContext<{ value: number; max: number } | null>(null)

function Root({ value = 0, max = 100, children }: { value?: number; max?: number; children?: React.ReactNode }) {
  return (
    <Ctx.Provider value={{ value, max }}>
      <div>{children}</div>
    </Ctx.Provider>
  )
}

function Indicator() {
  const c = useContext(Ctx)!
  return <i data-value={c.value} data-max={c.max} />
}

// `value` is named (and not forwarded); `max` travels in the rest.
function Wrap({ className, value, ...props }: { className?: string; value?: number; max?: number }) {
  return (
    <Root {...props}>
      <Indicator />
    </Root>
  )
}

export default function Page() {
  return <Wrap value={1} max={5} className="c" />
}
