// F230 case e: module C, it changes B's objects when it loads.
import { LABELS, list } from './labels-e'
LABELS.a = 'patched'
list.push('y')
