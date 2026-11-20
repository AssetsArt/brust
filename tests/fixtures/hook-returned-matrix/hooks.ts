import { useRef, useState } from 'react'

// F578 D6: a function each hook returns, used as an event handler by name, reads one kind of hook-scoped name.

// (1) / (2) a parameter (fed by a literal or a prop); (4) the hook's state and setter
export function usePlain(sel: string) {
  const [v, setV] = useState('')
  const run = () => setV(`${sel}!`)
  return { v, run }
}

// (2) a defaulted parameter
export function useDefaulted(sel = 'dflt') {
  const [v, setV] = useState('')
  const run = () => setV(`${sel}?`)
  return { v, run }
}

// (3) a member of the hook's object parameter
export function useObject({ sel }: { sel: string }) {
  const [v, setV] = useState('')
  const run = () => setV(`<${sel}>`)
  return { v, run }
}

// (5) a hook derived value
export function useDerived(n: string) {
  const [v, setV] = useState('')
  const label = `${n}#${n.length}`
  const run = () => setV(label)
  return { v, run }
}

// (6) a hook-local arrow
export function useLocalFn(n: string) {
  const [v, setV] = useState('')
  const wrap = (x: string) => `[${x}]`
  const run = () => setV(wrap(n))
  return { v, run }
}

// (9) a ref declared in the hook
export function useCounted() {
  const [v, setV] = useState('0')
  const r = useRef(0)
  const run = () => {
    r.current += 1
    setV(String(r.current))
  }
  return { v, run }
}
