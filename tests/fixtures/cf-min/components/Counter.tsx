import { useContext, useState } from 'react'
import { ThemeContext } from './theme'

export default function Counter({ start }: { start: number }) {
  const theme = useContext(ThemeContext)
  const [n, setN] = useState(start)
  return (
    <button type="button" className={theme} onClick={() => setN(n + 1)}>
      count {n}
    </button>
  )
}
