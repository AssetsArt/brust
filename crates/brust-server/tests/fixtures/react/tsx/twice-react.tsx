import Reviews from './Reviews'
export default function P({ a, b }: { a: string; b: string }) {
  return (<main><Reviews productId={a} /><Reviews productId={b} /></main>)
}
