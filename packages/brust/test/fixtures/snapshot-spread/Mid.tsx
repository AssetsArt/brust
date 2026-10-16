import Bubble from './Bubble'

// Mounts its Bubble with itself: the single-mount promise passes up to Mid's own caller (F295, transitive).
export default function Mid({ id, checked }: { id: string; checked: boolean }) {
  return <span><Bubble id={id} checked={checked} /></span>
}
