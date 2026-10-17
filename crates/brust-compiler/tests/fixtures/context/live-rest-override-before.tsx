import { useState } from 'react'

function Prim({ ...props }: any) {
  return <button {...props} />
}

function Toggle({ children, ...buttonProps }: any) {
  const [pressed, setPressed] = useState(false)
  return (
    <Prim type="button" aria-pressed={pressed} {...buttonProps} onClick={() => setPressed(!pressed)}>
      {children}
    </Prim>
  )
}

// F329b negative (W3): the override is written BEFORE a spread of keys known only at render, which may replace it
export default function Page({ ...extra }: any) {
  return (
    <main>
      <Toggle aria-pressed={undefined} {...extra}>
        one
      </Toggle>
    </main>
  )
}
