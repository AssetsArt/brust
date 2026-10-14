import { Dialog } from 'radix-ui'
import * as UI from './ui'

// A local object, not a React context (those are compiled, S2): its member tag stays a fallback.
const Ctx = { Provider: 'div' }
let Reassigned = Dialog.Root

export default function Fallback({ Tag }: any) {
  return (
    <div>
      <UI.Button />
      <Dialog.Sub.Trigger />
      <Ctx.Provider value={1}>
        <i />
      </Ctx.Provider>
      <Tag.Inner />
      <Reassigned />
    </div>
  )
}
