import { AspectRatio } from '../components/ui/aspect-ratio'

export default function Page() {
  return (
    <div className="w-[450px]">
      <AspectRatio ratio={16 / 9} className="rounded-lg bg-muted">
        <img src="/photo.jpg" alt="Photo" className="h-full w-full rounded-lg object-cover" />
      </AspectRatio>
    </div>
  )
}
