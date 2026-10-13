import { useReducer } from 'react'
export function Fn(props: any) { const [n, bump] = useReducer((x: number) => x + 1, 0); return <button onClick={() => bump()}>{props.label}{n}</button> }
export const Arrow = (props: any) => { const [n, bump] = useReducer((x: number) => x + 1, 0); return <button onClick={() => bump()}>{props.label}{n}</button> }
function Inner(props: any) { const [n, bump] = useReducer((x: number) => x + 1, 0); return <button onClick={() => bump()}>{props.label}{n}</button> }
export { Inner as Alias }
function Helper(props: any) { const [n, bump] = useReducer((x: number) => x + 1, 0); return <button onClick={() => bump()}>{props.label}{n}</button> }
export function Outer() { return <section><Helper label="h" /></section> }
