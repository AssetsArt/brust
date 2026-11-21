import { Frame } from '../ctx-hooks'
import { RM } from '../CtxPages'

/** 8c: the Provider value comes from the loader (differs per request). */
export default function Page({ who }: { who: string }) {
  return (
    <main>
      <Frame value={who}>
        <RM tid="a" />
      </Frame>
    </main>
  )
}
