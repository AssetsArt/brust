import { useContext } from 'react'
import { Ctx } from './shared'

export function BadgeS() {
  const c = useContext(Ctx)
  return <b>{c.ok}</b>
}
