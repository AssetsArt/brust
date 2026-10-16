import * as React from 'react'
const Badge: React.FC<{ label: string }> = (props) => <b>{props.label}</b>
const Counter = (props: { start: number }) => {
  const [n, setN] = React.useState(props.start)
  return <button type="button" onClick={() => setN(n + 1)}>{n}</button>
}
export { Badge, Counter as Root }
export default function P() { return <main><Badge label="x" /><Counter start={1} /></main> }
