export default function Card({ b, a = 'x'.toUpperCase(), c = b + '!', n: renamed = 2 }: any) {
  return <p>{a}{c}{renamed}</p>
}
