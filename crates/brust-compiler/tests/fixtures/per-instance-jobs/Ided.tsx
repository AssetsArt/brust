// A child with useId values: ids differ per row.
import { useId } from 'react'
export default function Ided({ text }: any) {
  const id = useId()
  return <label htmlFor={id}>{text}</label>
}
