import { Outer, OuterProp } from './ctx'
// F374: children that reach Prov in a spread or as its `children` prop.
export default function Page() {
  return (
    <main>
      <Outer>hello</Outer>
      <OuterProp>world</OuterProp>
    </main>
  )
}
