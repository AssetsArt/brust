// F230 case l: module C, it changes B's objects when it loads.
import { LABELS, list } from './labels-l'
LABELS.a = 'patched'
list.push('y')
