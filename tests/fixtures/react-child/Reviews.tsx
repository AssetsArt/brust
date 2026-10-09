import { useContext } from 'react'
import { ThemeContext } from './theme'

export default function Reviews({ productId }: { productId: string }) {
  const theme = useContext(ThemeContext)
  return <section className={theme}>Reviews for {productId}</section>
}
