// The rest spread comes BEFORE the live attribute: the attribute wins, so nothing can replace it.
import { useState } from 'react'
import Btn from './Btn'
export default function Before({ ...rest }: any) {
  const [on, setOn] = useState(false)
  return <Btn {...rest} aria-pressed={on} onClick={() => setOn(!on)} />
}
