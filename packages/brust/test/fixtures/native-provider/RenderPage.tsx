import { RMirror, RProvider, RTrigger } from './RenderProv'

export default function RenderPage() {
  return (
    <main>
      <RProvider
        render={({ checked, inForm }) => (
          <>
            <RTrigger />
            {checked && <RMirror />}
            {inForm && <small>free</small>}
          </>
        )}
      />
    </main>
  )
}
