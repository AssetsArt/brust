const make = () => 'x'
export default function Card({ a = make() }: any) {
  return <p>{a}</p>
}
