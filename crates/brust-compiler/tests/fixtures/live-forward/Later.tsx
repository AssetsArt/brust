// A live attribute followed by a spread that is NOT the component's own rest (keys known only at render): it may replace it.
import { useState } from 'react'
import Btn from './Btn'
export default function Later(props: any) {
  const [on, setOn] = useState(false)
  return <Btn aria-pressed={on} {...props.attrs} onClick={() => setOn(!on)} />
}
