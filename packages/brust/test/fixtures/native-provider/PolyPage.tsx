import { Poly, PolyContent, PolyTrigger } from './Poly'

export default function PolyPage() {
  return (
    <main>
      <Poly>
        <PolyTrigger asChild>
          <a data-from="child">
            Toggle
          </a>
        </PolyTrigger>
        <PolyContent>
          <p>poly body</p>
        </PolyContent>
      </Poly>
    </main>
  )
}
