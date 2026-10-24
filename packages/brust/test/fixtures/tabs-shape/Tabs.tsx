import * as React from 'react'
import { Presence } from '@radix-ui/react-presence'
import { useId } from './id'

// The shape of @radix-ui/react-tabs' Root, Trigger and Content (Presence, a hoisted Radix useId, a ref read during render in
// the style), without RovingFocusGroup (the real List/Trigger keep the page on React until F446/F447) and without the
// `{...contentProps}` the real Content spreads onto its element (a rest of unknown keys on the element Presence clones is the
// next wall of the real page: `getElementRef` cannot read it) and without `{present && children}` (the real Content reads its
// children inside Presence's function: an inlined instance with children cannot answer that yet), so the panel text is a prop.
type TabsCtx = { baseId: string; value: string; setValue: (v: string) => void }
const TabsContext = React.createContext<TabsCtx>({ baseId: '', value: '', setValue: () => {} })

export function Root({ defaultValue, children }: { defaultValue: string; children?: React.ReactNode }) {
  const [value, setValue] = React.useState(defaultValue)
  return (
    <TabsContext.Provider value={{ baseId: useId(), value, setValue }}>
      <div data-testid="root">{children}</div>
    </TabsContext.Provider>
  )
}

export function Trigger({ value, children }: { value: string; children?: React.ReactNode }) {
  const context = React.useContext(TabsContext)
  const isSelected = value === context.value
  return (
    <button
      type="button"
      role="tab"
      id={makeTriggerId(context.baseId, value)}
      aria-controls={makeContentId(context.baseId, value)}
      aria-selected={isSelected}
      data-state={isSelected ? 'active' : 'inactive'}
      data-testid={`trigger-${value}`}
      onClick={() => context.setValue(value)}
    >
      {children}
    </button>
  )
}

export function Content({ value, text, style }: { value: string; text: string; style?: React.CSSProperties }) {
  const context = React.useContext(TabsContext)
  const triggerId = makeTriggerId(context.baseId, value)
  const contentId = makeContentId(context.baseId, value)
  const isSelected = value === context.value
  const isMountAnimationPreventedRef = React.useRef(isSelected)
  React.useEffect(() => {
    const rAF = requestAnimationFrame(() => (isMountAnimationPreventedRef.current = false))
    return () => cancelAnimationFrame(rAF)
  }, [])
  return (
    <Presence present={isSelected}>
      {({ present }) => (
        <Panel
          data-state={isSelected ? 'active' : 'inactive'}
          role="tabpanel"
          aria-labelledby={triggerId}
          hidden={!present}
          id={contentId}
          tabIndex={0}
          data-testid={`content-${value}`}
          style={{ ...style, animationDuration: isMountAnimationPreventedRef.current ? '0s' : undefined }}
        >
          {present && text}
        </Panel>
      )}
    </Presence>
  )
}

// What `Primitive.div` is to Radix: a component that renders the host element with the props it is given.
function Panel({ children, ...props }: React.ComponentProps<'div'>) {
  return <div {...props}>{children}</div>
}

function makeTriggerId(baseId: string, value: string) {
  return `${baseId}-trigger-${value}`
}

function makeContentId(baseId: string, value: string) {
  return `${baseId}-content-${value}`
}
