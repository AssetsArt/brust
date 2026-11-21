import { useStore } from '@brust/core/store/react'
import { useState } from 'react'
import { hh } from './store'

// F580 cell 7: a function the hook returns, used as an event handler by name, that reads a store.
/** 7a: the handler reads the store value directly. */
export function useRead() {
  const [v, setV] = useState('none')
  const n = useStore(hh).count
  const run = () => setV('n=' + n)
  return { v, run }
}

/** 7b: the handler reads it through a hook derived value. */
export function useDerived() {
  const [v, setV] = useState('none')
  const n = useStore(hh).count
  const label = 'n=' + n
  const run = () => setV(label)
  return { v, run }
}

/** 7c: the handler writes the store (calls its action); the page shows the new value. */
export function useWrite() {
  const n = useStore(hh).count
  const run = () => hh.add()
  return { n, run }
}
