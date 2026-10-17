import { useState } from 'react'

function Inner({ onPressed, ...props }: any) {
  const [n, setN] = useState(0)
  return (
    <button
      {...props}
      data-n={n}
      onClick={() => {
        setN(n + 1)
        onPressed()
      }}
    />
  )
}

function Toggle({ children, ...buttonProps }: any) {
  const [pressed, setPressed] = useState(false)
  return (
    <Inner type="button" {...buttonProps} data-pressed={pressed} onPressed={() => setPressed(!pressed)}>
      {children}
    </Inner>
  )
}

// F329b negative: another NATIVE component sits between the call and the element, so the directive would bind in ITS instance
export default function Page() {
  const [a, setA] = useState(false)
  return (
    <main>
      <Toggle aria-checked={a}>one</Toggle>
      <button type="button" onClick={() => setA(!a)}>
        flip
      </button>
    </main>
  )
}
