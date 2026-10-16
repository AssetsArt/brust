// F219: module C. Imported only by the page, it changes B's objects when it loads.
import { LABELS, list } from './labels'
LABELS.a = 'patched'
list.push('y')
