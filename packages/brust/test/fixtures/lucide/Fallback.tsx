import { Heart } from 'lucide-react'

export default function Fallback({ label }: { label: string }) {
  return <Heart aria-label={label} />
}
