import { Heart, LucideProvider, Plus } from 'lucide-react'

export default function Provided() {
  return (
    <LucideProvider size={32} color="green" strokeWidth={3}>
      <Heart />
      <Plus size={10} />
    </LucideProvider>
  )
}
