import { useState } from 'react'

// F383: a style object with literal computed keys (Radix CollapsibleContent's
// `[`--radix-collapsible-content-height` as any]`) and a spread of the caller's style.
export default function Panel(props: { style?: Record<string, string>; children?: React.ReactNode }) {
  const [h, setH] = useState(0)
  return (
    <div
      data-testid="panel"
      onClick={() => setH(h + 10)}
      style={{
        [`--panel-height` as any]: h ? `${h}px` : undefined,
        ['--panel-kind' as any]: 'box',
        ...props.style,
      }}
    >
      {props.children}
    </div>
  )
}
