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

// F329b negative: the live key is written BEFORE a spread of keys known only at render, which may replace it
function Wrap({ ...extra }: any) {
  const [a, setA] = useState(false)
  return (
    <>
      <Toggle aria-checked={a} {...extra}>
        one
      </Toggle>
      <button type="button" onClick={() => setA(!a)}>
        flip
      </button>
    </>
  )
}

export default function Page() {
  return (
    <main>
      <Wrap data-x="1" />
    </main>
  )
}
