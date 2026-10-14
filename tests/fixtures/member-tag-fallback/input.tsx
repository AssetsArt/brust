import { createContext } from 'react'
import { Dialog } from 'radix-ui'
import * as UI from './ui'

const Ctx = createContext(1)
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
