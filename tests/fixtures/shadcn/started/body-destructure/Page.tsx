import { AspectRatio, Separator } from './parts'

export default function Page() {
  return (
    <main>
      <Separator />
      <Separator orientation="vertical" id="v" className="h-4" />
      <Separator decorative />
      <AspectRatio ratio={2} className="box">x</AspectRatio>
    </main>
  )
}
