import { useTransition } from 'react'
import data from './data.json'
import './page.css'

export default function Page() {
  const [pending] = useTransition()
  return <p className="v" data-testid="v">{data.label}{pending ? '!' : ''}</p>
}
