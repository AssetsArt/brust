import { useId } from 'react'
export default function Ided({ text }: any) { const id = useId(); return <label htmlFor={id}>{text}</label> }
