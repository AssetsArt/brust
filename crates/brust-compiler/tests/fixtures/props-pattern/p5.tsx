export default function C({ a = 'x'.toUpperCase(), b = Math.max(1, 2), c = a + '!' }: any) {
  return <div>{a}{b}{c}</div>
}
