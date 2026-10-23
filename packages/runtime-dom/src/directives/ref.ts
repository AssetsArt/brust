import { BINDERS, bindRef } from '../core-api'
BINDERS.push({
  match: (a) => a === 'x-ref',
  bind: ({ inst, el, raw }) => bindRef(inst, el, raw),
})
