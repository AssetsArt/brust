export default function Card({ a = 'x', c = a + '!' }: any) {
  return <p>{a}{c}</p>
}
