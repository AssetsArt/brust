// A Radix-shaped toggle: state of its own, live attributes BEFORE the spread of its own rest, the handler after it.
import { useState } from 'react'
import Btn from './Btn'
export default function Toggle2({ defaultOn, ...rest }: any) {
  const [on, setOn] = useState(defaultOn ?? false)
  return <Btn aria-pressed={on} data-state={on ? 'on' : 'off'} {...rest} onClick={() => setOn(!on)} />
}
