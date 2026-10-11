// Imports the (not yet existing) core-owned store API: jobs.js must leave it to the worker's core.
import { useReducer } from 'react'
// @ts-ignore: the module lands with the core lane (ignore, not expect-error, so it stays valid after)
import { defineStore } from '@brust/runtime-dom/store'

export const marker = typeof defineStore
export default function Stored() {
  const [n, bump] = useReducer((x: number) => x + 1, 0)
  return <b onClick={bump}>{n}{marker}</b>
}
