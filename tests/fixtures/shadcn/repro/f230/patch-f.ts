// F230 case f: the write sits in a function nothing calls; the scan counts it (documented over-refusal).
import { LABELS } from './labels-f'
export function later() {
  LABELS.a = 'later'
}
