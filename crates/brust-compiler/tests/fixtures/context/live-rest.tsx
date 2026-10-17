import { useState } from 'react'

// F329b: the shape of Radix `Toggle` (native: state of its own, its rest spread through a static `Primitive.button`) given live
// props by its caller
function Prim({ ...props }: any) {
  return <button {...props} />
}

function Toggle({ onPressedChange, children, ...buttonProps }: any) {
  const [pressed, setPressed] = useState(false)
  return (
    <Prim
      type="button"
      aria-pressed={pressed}
      data-state={pressed ? 'on' : 'off'}
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

export default function Page() {
  const [last, setLast] = useState('none')
  return (
    <main>
      <Toggle role="radio" aria-checked={last === 'a'} tabIndex={last === 'a' ? 0 : -1} aria-pressed={undefined} onPressedChange={() => setLast('a')}>
        A
      </Toggle>
      <Toggle role="radio" aria-checked={last === 'b'} tabIndex={last === 'b' ? 0 : -1} aria-pressed={undefined} onPressedChange={() => setLast('b')}>
        B
      </Toggle>
      <p>{last}</p>
    </main>
  )
}
