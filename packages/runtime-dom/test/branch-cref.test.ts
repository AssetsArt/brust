// F288 phase B (G5): `x-cref`, a callback ref inside an `x-if` branch (the compiler prints it only there). React's order:
// the ref attaches once the branch's DOM is placed and bound, before the owner's layout effects, an inner element's ref
// before an outer one's; on removal it detaches (the returned cleanup, else `cb(null)`) while the node is still in the
// document, then the node leaves.
import { expect, test, beforeEach } from 'bun:test'
import { defineBehavior, mount, unmount } from '../src'
import { signal } from '../src/signal'
beforeEach(() => { unmount(); document.body.innerHTML = '' })

test('a callback ref attaches with the bound branch and detaches before the node leaves, every toggle', () => {
  const open = signal(false); const log: string[] = []
  const cb = (n: Element | null) => { log.push(n ? `on ${n.id} text=${n.textContent} connected=${n.isConnected}` : 'off') }
  defineBehavior('cr1', ({ ref }) => { ref('$cr1', cb); return { open, label: 'bound' } })
  document.body.innerHTML = `<div x-data="cr1"><!--x-if--><p id="p" x-if="open" x-cref="$cr1" x-text="label" hidden></p></div>`
  mount()
  expect(log).toEqual([])
  for (let i = 0; i < 3; i++) { open.set(true); open.set(false) }
  expect(log).toEqual(Array(3).fill(['on p text=bound connected=true', 'off']).flat())
})

test('a returned cleanup replaces cb(null), and runs while the node is still in the document', () => {
  const open = signal(true); const log: string[] = []
  const cb = (n: Element) => { log.push(`on ${n.id}`); return () => log.push(`cleanup ${n.id} connected=${n.isConnected}`) }
  defineBehavior('cr2', ({ ref }) => { ref('$cr1', cb); return { open } })
  document.body.innerHTML = `<div x-data="cr2"><p id="p" x-if="open" x-cref="$cr1"></p></div>`
  mount()
  open.set(false)
  expect(log).toEqual(['on p', 'cleanup p connected=true'])
})

test('an inner branch attaches before the outer one, and an object ref is set and cleared', () => {
  const open = signal(true); const log: string[] = []; const obj = { current: null as Element | null }
  const outer = (n: Element | null) => { log.push(n ? `outer obj=${obj.current?.id}` : 'outer off') }
  defineBehavior('cr3', ({ ref }) => { ref('$cr1', outer); ref('$cr2', obj); return { open } })
  document.body.innerHTML = `<div x-data="cr3"><section id="s" x-if="open" x-cref="$cr1"><b id="b" x-if="open" x-cref="$cr2"></b></section></div>`
  mount()
  expect(log).toEqual(['outer obj=b'])
  open.set(false)
  expect(obj.current).toBeNull()
  expect(log).toEqual(['outer obj=b', 'outer off'])
})

// review F2 (Mellow): React 19 attaches in commit post-order (children first) and detaches a removed tree outer first.
test('nested callback refs in one branch attach inner first and detach outer first', () => {
  const open = signal(false); const log: string[] = []
  const cb = (tag: string) => (n: Element | null) => { log.push(`${tag} ${n ? 'on' : 'off'}`) }
  defineBehavior('cr6', ({ ref }) => { ref('$cr1', cb('outer')); ref('$cr2', cb('inner')); return { open } })
  document.body.innerHTML = `<div x-data="cr6"><!--x-if--><section x-if="open" x-cref="$cr1" hidden><b x-cref="$cr2"></b></section></div>`
  mount()
  open.set(true); open.set(false)
  expect(log).toEqual(['inner on', 'outer on', 'outer off', 'inner off'])
})

test('an inner branch inserted with its outer one attaches after an earlier sibling\'s ref (DOM post-order)', () => {
  const open = signal(false); const log: string[] = []
  const cb = (tag: string) => (n: Element | null) => { if (n) log.push(tag) }
  defineBehavior('cr7', ({ ref }) => { ref('$cr1', cb('section')); ref('$cr2', cb('i')); ref('$cr3', cb('b')); ref('$cr4', cb('u')); return { open } })
  document.body.innerHTML = `<div x-data="cr7"><!--x-if--><section x-if="open" x-cref="$cr1" hidden><i x-cref="$cr2"></i><!--x-if--><b x-if="open" x-cref="$cr3" hidden><u x-cref="$cr4"></u></b></section></div>`
  mount()
  open.set(true)
  expect(log).toEqual(['i', 'u', 'b', 'section'])
})

test('unmounting the host detaches a live branch\'s callback ref', () => {
  const log: string[] = []
  defineBehavior('cr4', ({ ref }) => { ref('$cr1', (n: Element | null) => log.push(n ? 'on' : 'off')); return { open: true } })
  document.body.innerHTML = `<div x-data="cr4"><p x-if="open" x-cref="$cr1"></p></div>`
  mount()
  unmount()
  expect(log).toEqual(['on', 'off'])
})

test('the callback attaches before the owner\'s layout effect re-runs (React: refs before layout effects)', () => {
  const open = signal(false); const log: string[] = []; let node: Element | null = null
  defineBehavior('cr5', ({ ref, effect }) => {
    ref('$cr1', (n: Element | null) => { node = n; log.push(n ? 'ref on' : 'ref off') })
    effect(() => { log.push(`layout open=${open()} node=${node ? 'y' : 'n'}`) }, true)
    return { open }
  })
  document.body.innerHTML = `<div x-data="cr5"><!--x-if--><p x-if="open" x-cref="$cr1" hidden></p></div>`
  mount()
  open.set(true)
  expect(log).toEqual(['layout open=false node=n', 'ref on', 'layout open=true node=y'])
})

test('on a nested host in the branch the cell is the caller\'s, attached once the host mounted, detached with the branch', async () => {
  const open = signal(true); const log: string[] = []
  defineBehavior('cr6', ({ ref }) => { ref('$cr1', (n: Element | null) => log.push(n ? `on ${n.id}` : 'off')); return { open } })
  defineBehavior('cr6_child', ({ el }) => { log.push(`child ${el.id} mounted`); return {} })
  document.body.innerHTML = `<div x-data="cr6"><brust-if x-if="open"><div id="h" x-data="cr6_child" x-cref="$cr1"></div></brust-if></div>`
  mount()
  expect(log).toEqual(['child h mounted', 'on h'])
  open.set(false)
  expect(log).toEqual(['child h mounted', 'on h', 'off'])
})
