import { Edit, Heart, Plus } from 'lucide-react'
import Star from 'lucide-react/dist/esm/icons/star.mjs'

export default function StaticIcons({ big, tone }: { big: number; tone: string }) {
  return (
    <div>
      <p id="lit">
        <Heart size={16} color="red" strokeWidth={1.5} className="love" aria-label="loved" />
        <Plus />
        <Edit size={20} />
        <Star nonScalingStroke />
      </p>
      <p id="dyn">
        <Heart size={big} color={tone} strokeWidth={1} className={`ico ${tone}`} />
      </p>
    </div>
  )
}
