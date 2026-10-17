import { Outer } from './ctx'
// F374: text children travel to Prov in the wrapper's props spread.
export default function Page() {
  return (
    <main>
      <Outer id="1">hello</Outer>
      <Outer id="2">
        <p>para</p>
      </Outer>
    </main>
  )
}
