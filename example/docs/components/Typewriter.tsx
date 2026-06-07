// NATIVE INTERACTIVE COMPONENT (react-free) — the hero headline's rotating word.
// A behavior types/deletes through a list of words on the shared signal, bound to
// the DOM with x-text; the caret blinks via CSS. Zero React — fitting, since the
// line itself reads "Share one state." This is native interactivity in the title.
import { signal } from 'brustjs/store'
import type { BehaviorCtx } from 'brustjs/native'

const WORDS = ['state.', 'store.', 'signal.', 'model.']

export const behavior = ({ effect, onCleanup }: BehaviorCtx) => {
  const word = signal(WORDS[0] as string)

  effect(() => {
    // Respect reduced-motion: leave the first word static, no typing loop.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return

    let alive = true
    let wi = 0
    let ci = (WORDS[0] as string).length
    let deleting = true
    let timer: ReturnType<typeof setTimeout>

    const tick = () => {
      if (!alive) return
      const w = WORDS[wi] as string
      if (deleting) {
        ci -= 1
        word.set(w.slice(0, ci))
        if (ci <= 0) {
          deleting = false
          wi = (wi + 1) % WORDS.length
          timer = setTimeout(tick, 260)
          return
        }
        timer = setTimeout(tick, 45)
      } else {
        ci += 1
        word.set(w.slice(0, ci))
        if (ci >= w.length) {
          deleting = true
          timer = setTimeout(tick, 1500) // hold the full word
          return
        }
        timer = setTimeout(tick, 80)
      }
    }

    timer = setTimeout(tick, 1500)
    onCleanup(() => {
      alive = false
      clearTimeout(timer)
    })
  })

  return { word }
}

export default function Typewriter() {
  return (
    <span className="b-typer">
      <span className="b-gradient-text">
        Share one <span x-text="word">state.</span>
      </span>
      <span className="b-caret" aria-hidden="true"></span>
    </span>
  )
}
