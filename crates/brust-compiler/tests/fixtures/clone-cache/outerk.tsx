import { Both, Frame, Prov } from './ctx'
// F372: an outer K Provider around Prov: React reads the INNER one (Frame inside Prov) for the content.
export default function Page() {
  return (
    <main>
      <Frame>
        <Prov>
          <Both label="AAA" />
        </Prov>
      </Frame>
    </main>
  )
}
