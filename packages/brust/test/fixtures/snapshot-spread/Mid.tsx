import Bubble from './Bubble'

// Mounts its Bubble with itself and hands it the prop it got: Mid mounts again with its caller's condition, so the Bubble is linked to Mid's props (F300).
export default function Mid({ id, checked }: { id: string; checked: boolean }) {
  return <span><Bubble id={id} checked={checked} /></span>
}
