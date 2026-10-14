import { BINDERS, parsed, member } from '../core-api'

// React's SyntheticEvent has five members a DOM event lacks; code written for React calls them on the event it is handed
// (Radix: `event.isPropagationStopped()`), and on a DOM event that is a TypeError (F195). Added to the event the handler
// receives, never to Event.prototype, so nothing else on the page changes.
const SYNTHETIC: PropertyDescriptorMap = {
  isPropagationStopped: { value(this: Event) { return this.cancelBubble } },
  isDefaultPrevented: { value(this: Event) { return this.defaultPrevented } },
  persist: { value() {} },
  isPersistent: { value: () => true },
  nativeEvent: { get(this: Event) { return this } },
}
BINDERS.push({
  match: (a) => a.startsWith('x-on-'),
  bind: ({ inst, el, attr, raw, scope }) => {
    const event = attr.slice('x-on-'.length)
    const p = parsed(inst, attr, raw); if (!p) return
    const handler = (e: Event) => {
      if (!('isPropagationStopped' in e)) Object.defineProperties(e, SYNTHETIC)
      const fn = member(inst, p, attr)
      if (typeof fn !== 'function') return
      const args = p.bindings.map((b) => scope[b])
      ;(fn as (...a: unknown[]) => void)(...args, e)
    }
    el.addEventListener(event, handler)
    inst.onCleanup(() => el.removeEventListener(event, handler))
  },
})
