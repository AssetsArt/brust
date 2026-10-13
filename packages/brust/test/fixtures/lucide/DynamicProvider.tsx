import { Heart, LucideProvider } from 'lucide-react'

export default function DynProvider({ size }: { size: number }) {
  return (
    <LucideProvider size={size}>
      <Heart />
    </LucideProvider>
  )
}
