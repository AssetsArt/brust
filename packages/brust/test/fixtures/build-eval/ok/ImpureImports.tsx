import { home } from './envhelper'
import { size } from './fshelper'
import { next } from './statehelper'

export default function ImpureImports() {
  return (
    <p>
      <span id="env">{home()}</span>
      <span id="state">{next()}</span>
      <span id="fs">{size()}</span>
    </p>
  )
}
