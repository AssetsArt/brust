import { Frame, useCtxDerived, useCtxRead } from './ctx-hooks'

export function RM({ tid }: { tid: string }) {
  const s = useCtxRead()
  return <button type="button" data-testid={tid} onClick={s.run}>{s.v}</button>
}
export function RD({ tid }: { tid: string }) {
  const { v, run } = useCtxRead()
  return <button type="button" data-testid={tid} onClick={run}>{v}</button>
}
function DM({ tid }: { tid: string }) {
  const s = useCtxDerived()
  return <button type="button" data-testid={tid} onClick={s.run}>{s.v}</button>
}
function DD({ tid }: { tid: string }) {
  const { v, run } = useCtxDerived()
  return <button type="button" data-testid={tid} onClick={run}>{v}</button>
}

export function C8aM() {
  return <main><Frame value="alpha"><RM tid="a" /></Frame></main>
}
export function C8aD() {
  return <main><Frame value="alpha"><RD tid="a" /></Frame></main>
}
export function C8bM() {
  return <main><Frame value="alpha"><DM tid="a" /></Frame></main>
}
export function C8bD() {
  return <main><Frame value="alpha"><DD tid="a" /></Frame></main>
}
/** 8c: the Provider value comes from the loader (differs per request). */
export function C8cM({ who }: { who: string }) {
  return <main><Frame value={who}><RM tid="a" /></Frame></main>
}
export function C8cD({ who }: { who: string }) {
  return <main><Frame value={who}><RD tid="a" /></Frame></main>
}
/** 8d: two Providers with different values, one consumer under each. */
export function C8dM() {
  return <main><Frame value="one"><RM tid="a" /></Frame><Frame value="two"><RM tid="b" /></Frame></main>
}
export function C8dD() {
  return <main><Frame value="one"><RD tid="a" /></Frame><Frame value="two"><RD tid="b" /></Frame></main>
}
/** 8e: a nested Provider overrides the outer one. */
export function C8eM() {
  return <main><Frame value="outer"><RM tid="a" /><Frame value="inner"><RM tid="b" /></Frame></Frame></main>
}
export function C8eD() {
  return <main><Frame value="outer"><RD tid="a" /><Frame value="inner"><RD tid="b" /></Frame></Frame></main>
}
/** 8f: the default value (no Provider above). */
export function C8fM() {
  return <main><RM tid="a" /></main>
}
export function C8fD() {
  return <main><RD tid="a" /></main>
}
