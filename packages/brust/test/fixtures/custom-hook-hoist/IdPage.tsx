import { useScopedId } from './hooks'

export default function IdPage() {
  return (
    <main>
      <label data-testid="label" htmlFor={useScopedId('f')}>
        name
      </label>
      <span data-testid="desc" id={useScopedId('d')}>
        d
      </span>
    </main>
  )
}
