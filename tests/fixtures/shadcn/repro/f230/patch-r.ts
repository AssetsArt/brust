// F230 case r: module C, it changes B's objects when it loads.
import { LABELS, list } from './labels-r'
LABELS.a = 'patched'
list.push('y')
