import { useState } from 'react'
export default function P(props: { list: string[] }) {
  const [s, setS] = useState('a')
  return <button type="button" onClick={() => setS('b')} data-hit={props.list.includes(s) ? 'y' : 'n'}>{s}</button>
}
