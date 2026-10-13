import { Separator } from '../components/ui/separator'

export default function Page() {
  return (
    <div>
      <h4 className="text-sm leading-none font-medium">Radix Primitives</h4>
      <Separator className="my-4" />
      <div className="flex h-5 items-center gap-4 text-sm">
        <div>Blog</div>
        <Separator orientation="vertical" />
        <div>Docs</div>
      </div>
    </div>
  )
}
