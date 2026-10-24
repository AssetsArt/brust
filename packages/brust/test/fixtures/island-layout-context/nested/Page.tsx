import { useContext } from 'react'
import { Ctx } from './Outer'

export default function Page() {
  const v = useContext(Ctx)
  return <p data-testid="v">{v}</p>
}
