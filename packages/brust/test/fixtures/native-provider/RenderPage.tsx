import { RMirror, RProvider, RTrigger } from './RenderProv'

export default function RenderPage() {
  return (
    <main>
      <RProvider
        render={({ checked }) => (
          <>
            <RTrigger />
            {checked && <RMirror />}
          </>
        )}
      />
    </main>
  )
}
