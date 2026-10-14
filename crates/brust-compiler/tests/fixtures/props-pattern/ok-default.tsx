export default function C({ a = 'x', b: renamed = 2 }: { a?: string; b?: number }) {
  return <div>{a}{renamed}</div>
}
