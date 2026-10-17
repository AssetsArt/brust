import { Both, Outer } from './ctx'
// F374 + F371: content reading Frame's context travels to Prov in the wrapper's props spread.
export default function Page() {
  return (
    <main>
      <Outer id="1">
        <Both label="AAA" />
      </Outer>
    </main>
  )
}
