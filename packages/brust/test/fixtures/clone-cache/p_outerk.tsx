import { Both, Frame, Prov } from './ctx'
// F372: an outer K Provider around Prov: the content reads the INNER one (Frame inside Prov), as React does.
export default function Page() {
  return (
    <main>
      <Frame id="o">
        <Prov id="1">
          <Both label="AAA" />
        </Prov>
      </Frame>
    </main>
  )
}
