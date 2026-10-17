import { Switch } from 'radix-ui'

// switch-provider-chain PR2: Radix's Switch.Root on its own (no Thumb): the trigger binds the Provider's live
// `checked` ahead of a spread of its own rest (link 3) and receives the Root's own `__scopeSwitch` unchanged.
export default function Page() {
  return (
    <main>
      <Switch.Root id="airplane" aria-label="Airplane Mode" />
    </main>
  )
}
