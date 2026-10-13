import { useReducer } from 'react'

// useReducer keeps each of these a React island. They share ONE module instance of this file: `total` is
// module state, so a click on any of them shows how many clicks the whole page has seen.
let total = 0
const bump = () => ++total

/** `export function`, imported by name. */
export function Alpha({ label }: { label: string }) {
  const [n, hit] = useReducer(() => bump(), 0)
  return (
    <button type="button" data-testid="alpha" onClick={() => hit()}>
      {label} {n}
    </button>
  )
}

/** `export const` of an arrow function: a binding the compiler does not read, so an island. */
export const Beta = ({ label }: { label: string }) => {
  const [n, hit] = useReducer(() => bump(), 0)
  return (
    <button type="button" data-testid="beta" onClick={() => hit()}>
      {label} {n}
    </button>
  )
}

function Gamma({ label }: { label: string }) {
  const [n, hit] = useReducer(() => bump(), 0)
  return (
    <button type="button" data-testid="gamma" onClick={() => hit()}>
      {label} {n}
    </button>
  )
}

/** `export { X as Y }`: imported as `Gam`. */
export { Gamma as Gam }

function Helper({ label }: { label: string }) {
  const [n, hit] = useReducer(() => bump(), 0)
  return (
    <button type="button" data-testid="helper" onClick={() => hit()}>
      {label} {n}
    </button>
  )
}

/** Exported and static; the helper it renders is an island nothing exports (the build exposes it). */
export function Outer() {
  return (
    <section>
      <Helper label="helper" />
    </section>
  )
}
