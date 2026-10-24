import { useTransition } from 'react'
import { label } from './theme'

export default function Page() {
  const [pending] = useTransition()
  return <p data-testid="v">{label}{pending ? '!' : ''}</p>
}
