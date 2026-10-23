import * as React from 'react'

// A forwardRef content component, as Radix's CollapsibleContentImpl / TabsContent are: `present` is Presence's `isPresent`.
export const Panel = React.forwardRef<HTMLDivElement, { present: boolean; open: boolean; children?: React.ReactNode }>(
  function Panel(props, ref) {
    const { present, open, children } = props
    return (
      <div ref={ref} className="panel" data-testid="panel" data-present={present ? 'y' : 'n'} data-open={open ? 'y' : 'n'}>
        {children}
      </div>
    )
  },
)
