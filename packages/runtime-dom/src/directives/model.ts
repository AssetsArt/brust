import { BINDERS } from './index'
import { parsed, member } from './common'
import { isSignal, type Signal } from '../signal'
import { warnOnce } from '../warn'
BINDERS.push({
  match: (a) => a === 'x-model',
  bind: ({ inst, el, attr, raw }) => {
    const p = parsed(inst, attr, raw); if (!p) return
    const sig = member(inst, p, attr)
    if (!isSignal(sig) || typeof (sig as Signal<unknown>).set !== 'function') {
      warnOnce(`model:${inst.name}:${raw}`, `x-model="${raw}" on x-data="${inst.name}" must name a writable signal`); return
    }
    const s = sig as Signal<unknown>
    const input = el as HTMLInputElement
    const type = input.type
    if (input instanceof HTMLInputElement && type === 'checkbox') {
      const h = () => s.set(input.checked); el.addEventListener('change', h); inst.onCleanup(() => el.removeEventListener('change', h))
      inst.effect(() => { input.checked = Boolean(s()) })
    } else if (input instanceof HTMLInputElement && type === 'radio') {
      const h = () => { if (input.checked) s.set(input.value) }; el.addEventListener('change', h); inst.onCleanup(() => el.removeEventListener('change', h))
      inst.effect(() => { input.checked = s() === input.value })
    } else if (el instanceof HTMLSelectElement) {
      if (el.multiple) { warnOnce(`model:multi:${inst.name}`, `x-model on select[multiple] is not supported`); return }
      const h = () => s.set(el.value); el.addEventListener('change', h); inst.onCleanup(() => el.removeEventListener('change', h))
      const apply = () => { const v = s(); if (el.value !== String(v)) el.value = String(v ?? '') }
      inst.effect(apply)
      const mo = new MutationObserver(() => apply()); mo.observe(el, { childList: true }); inst.onCleanup(() => mo.disconnect())
    } else {
      const h = () => s.set(input.value); el.addEventListener('input', h); inst.onCleanup(() => el.removeEventListener('input', h))
      inst.effect(() => { const v = s(); if (input.value !== String(v ?? '')) input.value = String(v ?? '') })
    }
  },
})
