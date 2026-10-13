// The address line on top of a "browser" frame: the URL on the left, what the pane shows on the right.
export default function UrlBar({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-rule bg-paper px-[.8rem] py-[.45rem] font-mono text-[12px] text-ink-2">
      <span>{url}</span>
      <span className="text-amber-ink">{label}</span>
    </div>
  )
}
