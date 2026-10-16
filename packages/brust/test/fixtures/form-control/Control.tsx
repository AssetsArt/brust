import { useState } from 'react'
import Bubble from './Bubble'

// Radix Switch/Checkbox's Provider shape (F297): `control` is null on the server, so the server takes the `true` arm;
// the client recomputes once the ref callback sets `control`, and drops the hidden input outside a form.
export default function Control({ id, form }: { id: string; form?: string }) {
  const [checked, setChecked] = useState(false)
  const [control, setControl] = useState<HTMLButtonElement | null>(null)
  const isFormControl = control ? !!form || !!control.closest('form') : true
  return (
    <span>
      <button type="button" ref={setControl} data-testid={`${id}-button`} data-form={isFormControl ? 'y' : 'n'} onClick={() => setChecked(!checked)}>
        {checked ? 'on' : 'off'}
      </button>
      {isFormControl && <Bubble id={id} checked={checked} />}
    </span>
  )
}
