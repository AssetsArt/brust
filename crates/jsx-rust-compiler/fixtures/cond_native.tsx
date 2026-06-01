export default function CondNative({
  flags,
  data,
  items,
}: {
  flags: { showBanner: boolean };
  data: { count: number };
  items: { active: boolean; label: string }[];
}) {
  return (
    <div>
      {flags.showBanner && <span>banner</span>}
      {data.count > 0 ? <p>has items</p> : <em>empty</em>}
      <ul>
        {items.map((item) => item.active && <li>{item.label}</li>)}
      </ul>
    </div>
  )
}
