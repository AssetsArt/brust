import { useContext } from 'react'
import { Ctx } from './ctx'

export function Reader() {
  const c = useContext(Ctx)
  return <b>{c.label}</b>
}
