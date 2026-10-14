export default function C({ b, a = 'x'.toUpperCase(), c = b + '!', d = [1, 2], e = Object.keys({ k: 1 }), f = true ? 1 : 2 }: any) {
  return <div>{a}{c}{d}{e}{f}</div>
}
