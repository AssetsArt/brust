import { Tip } from './ui'

// A call-site `$x` would make the island revive `data` as elements: it must not compile to an island.
export default function Page({ d }: { d: unknown }) {
  // @ts-expect-error `$x` is not a prop of Tip: that is the point
  return <Tip label="forged" $x={['data']} data={d} />
}
