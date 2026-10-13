import { Heart, LucideProvider } from 'lucide-react'

type P = { s?: number; c?: string; w?: number; k?: string }

// Props the loader leaves out are `undefined`: React renders the defaults (and the provider's values).
export default function UndefinedProps({ s, c, w, k }: P) {
  return (
    <div>
      <p id="plain">
        <Heart size={s} color={c} strokeWidth={w} className={k} />
      </p>
      <p id="provided">
        <LucideProvider size={32} color="green" strokeWidth={3}>
          <Heart size={s} color={c} strokeWidth={w} />
        </LucideProvider>
      </p>
    </div>
  )
}
