import { Dialog } from 'radix-ui'
import { Root, Trigger } from './ui'

const Close = Dialog.Close

export default function Alias() {
  return (
    <div>
      <Root />
      <Trigger />
      <Close />
    </div>
  )
}
