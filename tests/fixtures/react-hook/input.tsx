import { useContext } from 'react'
import { ThemeContext } from './theme'

export default function Themed({ label }: { label: string }) {
  const theme = useContext(ThemeContext)
  return <span className={theme}>{label}</span>
}
