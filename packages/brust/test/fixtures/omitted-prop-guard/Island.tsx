import { useSyncExternalStore } from 'react'

// A real React island: a hook brust does not lower; the server renders it through a job.
export function Island({ id }: { id: string }) {
  const v = useSyncExternalStore(
    () => () => {},
    () => 1,
    () => 1,
  )
  return (
    <i data-island={id}>
      {id}:{v}
    </i>
  )
}
