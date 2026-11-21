import { hh } from './store'
import { useDerived, useRead, useWrite } from './store-hooks'

/** Changes the store from another component (7d, 7e). */
export function Bump() {
  return (
    <button type="button" data-testid="bump" onClick={() => hh.add()}>
      bump
    </button>
  )
}

export function S7aM() {
  const s = useRead()
  return (
    <main>
      <button type="button" data-testid="run" onClick={s.run}>{s.v}</button>
    </main>
  )
}
export function S7aD() {
  const { v, run } = useRead()
  return (
    <main>
      <button type="button" data-testid="run" onClick={run}>{v}</button>
    </main>
  )
}

export function S7bM() {
  const s = useDerived()
  return (
    <main>
      <button type="button" data-testid="run" onClick={s.run}>{s.v}</button>
    </main>
  )
}
export function S7bD() {
  const { v, run } = useDerived()
  return (
    <main>
      <button type="button" data-testid="run" onClick={run}>{v}</button>
    </main>
  )
}

export function S7cM() {
  const s = useWrite()
  return (
    <main>
      <button type="button" data-testid="run" onClick={s.run}>{s.n}</button>
    </main>
  )
}
export function S7cD() {
  const { n, run } = useWrite()
  return (
    <main>
      <button type="button" data-testid="run" onClick={run}>{n}</button>
    </main>
  )
}

export function S7dM() {
  const s = useRead()
  return (
    <main>
      <Bump />
      <button type="button" data-testid="run" onClick={s.run}>{s.v}</button>
    </main>
  )
}
export function S7dD() {
  const { v, run } = useRead()
  return (
    <main>
      <Bump />
      <button type="button" data-testid="run" onClick={run}>{v}</button>
    </main>
  )
}

function Inst7eM({ tid }: { tid: string }) {
  const s = useRead()
  return <button type="button" data-testid={tid} onClick={s.run}>{s.v}</button>
}
function Inst7eD({ tid }: { tid: string }) {
  const { v, run } = useRead()
  return <button type="button" data-testid={tid} onClick={run}>{v}</button>
}
export function S7eM() {
  return (
    <main>
      <Bump />
      <Inst7eM tid="a" />
      <Inst7eM tid="b" />
    </main>
  )
}
export function S7eD() {
  return (
    <main>
      <Bump />
      <Inst7eD tid="a" />
      <Inst7eD tid="b" />
    </main>
  )
}
