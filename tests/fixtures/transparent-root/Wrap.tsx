import Rows from './Rows'

// A component root (not an element): the same transparent collapse.
export default function Wrap({ a, b }: { a: string; b: string }) {
  return <Rows a={a} b={b} />
}
