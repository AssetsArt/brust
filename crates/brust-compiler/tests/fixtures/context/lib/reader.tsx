import { useContext } from 'react'
import { Ctx } from '../island-cross'

export function Reader() {
  const c = useContext(Ctx)
  return <b>{c.label}</b>
}
