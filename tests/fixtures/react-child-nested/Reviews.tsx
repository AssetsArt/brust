import { useContext } from 'react'
import { ThemeContext } from './theme'

export default function Reviews({ item, limit }: { item: { id: string; name: string }; limit: number }) {
  const theme = useContext(ThemeContext)
  return <section className={theme}>Reviews for {item.name} ({limit})</section>
}
