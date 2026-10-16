import { useEffect, useState } from 'react'

// Radix's BubbleInput effect: the input is state set by a ref callback; each change of `checked` goes through the
// native `checked` setter, then a click event that bubbles to the form.
export default function Bubble({ id, checked }: { id: string; checked: boolean }) {
  const [input, setInput] = useState<HTMLInputElement | null>(null)
  useEffect(() => {
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set
    if (!setter) return
    setter.call(input, checked)
    input.dispatchEvent(new Event('click', { bubbles: true }))
  }, [input, checked])
  return <input type="checkbox" aria-hidden tabIndex={-1} ref={setInput} data-testid={`${id}-input`} />
}
