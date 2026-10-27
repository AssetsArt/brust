// The /mood-b island: the same store as Mood, its own module.
import { useStore } from '@brust/core/store/react'
import { useTransition } from 'react'
import { mood } from './stores/mood'

export default function Mood2() {
  useTransition()
  const m = useStore(mood)
  return <output id="mood-b">{m.v}</output>
}
