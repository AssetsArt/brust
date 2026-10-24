import { useContext } from 'react'
import { Theme } from './Layout'

export default function Page() {
  const v = useContext(Theme)
  return <p data-testid="v">{v}</p>
}
