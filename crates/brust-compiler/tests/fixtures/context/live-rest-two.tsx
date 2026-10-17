import { useState } from 'react'

function Prim({ ...props }: any) {
  return <button {...props} />
}

function Toggle({ onPressedChange, children, ...buttonProps }: any) {
  const [pressed, setPressed] = useState(false)
  return (
    <Prim
      type="button"
      aria-pressed={pressed}
      {...buttonProps}
      onClick={() => {
        setPressed(!pressed)
        onPressedChange?.(!pressed)
      }}
    >
      {children}
    </Prim>
  )
}

// F329b: two call sites with DIFFERENT live key sets share one Toggle chunk
export default function Page() {
  const [a, setA] = useState(false)
  const [n, setN] = useState(0)
  return (
    <main>
      <Toggle aria-checked={a} onPressedChange={() => setA(!a)}>
        one
      </Toggle>
      <Toggle data-count={n} tabIndex={n} onPressedChange={() => setN(n + 1)}>
        two
      </Toggle>
    </main>
  )
}
