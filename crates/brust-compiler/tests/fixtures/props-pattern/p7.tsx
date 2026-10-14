export default function C({ a = 'x', c = a + '!' }: any) {
  return <div>{a}{c}</div>
}
