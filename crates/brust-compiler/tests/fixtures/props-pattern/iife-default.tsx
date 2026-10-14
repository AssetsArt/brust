export default function C({ a = (() => '<i>')() }: { a?: string }) {
  return <div>{a}</div>
}
