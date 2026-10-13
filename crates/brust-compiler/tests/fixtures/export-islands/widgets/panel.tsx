import { useReducer } from 'react'
export function Panel(props: any) { const [n, bump] = useReducer((x: number) => x + 1, 0); return <button onClick={() => bump()}>{props.label}{n}</button> }
