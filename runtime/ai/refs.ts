import { onBeforeNavigate } from '../navigation/store.ts'

export type Ref = `e${number}`
export type ActionTarget = Ref | string

export interface BrustError {
  code:
    | 'stale-ref'
    | 'not-found'
    | 'ambiguous'
    | 'timeout'
    | 'disabled'
    | 'nav-failed'
    | 'bad-input'
  message: string
  hint?: string
}

export interface ErrorResult {
  ok: false
  error: BrustError
}

const elementRefs = new WeakMap<Element, Ref>()
let refElements = new Map<Ref, WeakRef<Element>>()
let nextRef = 1
let generation = 0

export function mintRef(element: Element): Ref {
  const existing = elementRefs.get(element)
  if (existing && refElements.get(existing)?.deref() === element) return existing
  const ref = `e${nextRef++}` as Ref
  elementRefs.set(element, ref)
  refElements.set(ref, new WeakRef(element))
  return ref
}

export function bumpRefGeneration(): void {
  generation += 1
  nextRef = 1
  refElements = new Map()
}

export function refGeneration(): number {
  return generation
}

function error(code: BrustError['code'], message: string, hint?: string): ErrorResult {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) } }
}

export function resolveTarget(
  target: ActionTarget,
  root: ParentNode = document,
): Element | ErrorResult {
  if (typeof target !== 'string' || target.length === 0) {
    return error('bad-input', 'target must be a non-empty ref or CSS selector')
  }
  if (/^e\d+$/.test(target)) {
    const element = refElements.get(target as Ref)?.deref()
    if (!element?.isConnected) {
      return error('stale-ref', `ref ${target} is no longer valid`, 're-run Brust.struct()')
    }
    return element
  }
  let matches: Element[]
  try {
    matches = Array.from(root.querySelectorAll(target))
  } catch {
    return error('bad-input', `invalid CSS selector: ${target}`)
  }
  if (matches.length === 0) return error('not-found', `no element matches selector: ${target}`)
  if (matches.length > 1) {
    return error('ambiguous', `selector matches ${matches.length} elements: ${target}`)
  }
  return matches[0]!
}

// Invalidate snapshot refs as soon as a navigation begins. A failed navigation
// may leave the same DOM in place, but the public contract deliberately makes
// every navigation attempt a generation boundary.
onBeforeNavigate(() => bumpRefGeneration())

export function __resetRefsForTest(): void {
  bumpRefGeneration()
  generation = 0
}
