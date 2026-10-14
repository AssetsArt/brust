const D = 'dd'
export default function C({ a = D }: { a?: string }) {
  return <div>{a}</div>
}
