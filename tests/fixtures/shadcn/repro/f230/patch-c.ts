// F230 case c (Afrojack, round 2): the writes run inside callbacks handed to load-time calls.
import { LABELS, list } from './labels-c'
;[['a', 'patched']].forEach(([k, v]) => {
  ;(LABELS as Record<string, string>)[k!] = v!
})
new Promise<void>((resolve) => {
  list.push('y')
  resolve()
})
