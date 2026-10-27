// useTransition => React tier: an island that renders the mood store. /mood-a and /mood-b use different files, so
// /mood-b brings a module of its own to load (F462: the window between the new seed tags and the swap).
import { useStore } from '@brust/core/store/react'
import { useTransition } from 'react'
import { mood } from './stores/mood'

export default function Mood() {
  useTransition()
  const m = useStore(mood)
  return <output id="mood-a">{m.v}</output>
}
