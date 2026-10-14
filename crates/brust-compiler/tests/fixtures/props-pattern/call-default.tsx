const make = () => 'x'
export default function C({ a = make() }: { a?: string }) {
  return <div>{a}</div>
}
